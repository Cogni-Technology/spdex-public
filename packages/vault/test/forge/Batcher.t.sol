// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.33;

import {ForkTest, IWETHTest, Plan} from "./utils/Fork.sol";
import {VmLog, console} from "./utils/Test.sol";
import {
    BareRevert,
    GasBurner,
    GasProbe,
    IBatcherMock,
    LyingVault,
    OneWordVault,
    PayingVault,
    ReenteringVault,
    ReturnBomb,
    SilentVault,
    V1ShapedVault
} from "./utils/Mocks.sol";
import {SpdexDcaVault} from "../../contracts/SpdexDcaVault.sol";
import {SpdexVaultBatcher} from "../../contracts/SpdexVaultBatcher.sol";
import {SpdexVaultFactory} from "../../contracts/SpdexVaultFactory.sol";

/// Cheatcodes this file needs beyond the shared harness.
struct BatcherCallGas {
    uint64 gasLimit;
    uint64 gasTotalUsed;
    uint64 gasMemoryUsed;
    int64 gasRefunded;
    uint64 gasRemaining;
}

interface VmBatcher {
    function snapshotState() external returns (uint256);
    function revertToState(uint256 snapshotId) external returns (bool);
    function cool(address target) external;
    function lastCallGas() external view returns (BatcherCallGas memory);
}

/// The batcher: it buys every due vault its caller lists, from any factory, each paying the
/// caller's `rewardTo` directly, measures what `rewardTo` received and holds nothing, survives
/// any vault's refusal, gas or answer, and refuses the batches it says it refuses. Real vaults
/// on the fork where the vault's own behaviour is the point — its community window among it;
/// vault-shaped mocks where only a hostile or odd `execute` can show it.
contract BatcherTest is ForkTest {
    VmBatcher internal constant vmb = VmBatcher(address(uint160(uint256(keccak256("hevm cheat code")))));

    bytes32 internal constant BATCH_TOPIC = keccak256("Batch(address,address,uint256,uint256,uint256,uint256)");
    bytes32 internal constant TRIGGERED_TOPIC = keccak256("Triggered(address,uint256,uint256)");
    bytes32 internal constant NOT_TRIGGERED_TOPIC = keccak256("NotTriggered(address,bytes4,uint256)");
    bytes32 internal constant TRANSFER_TOPIC = keccak256("Transfer(address,address,uint256)");
    /// keccak256("spdex.vault.batcher.v2"): BATCHER_SALT in `src/artifacts.ts`. (v1's was
    /// "spdex.vault.batcher.v1", V1_BATCHER_SALT.)
    bytes32 internal constant BATCHER_SALT = keccak256("spdex.vault.batcher.v2");

    /// The least gas a batch gives each vault, which is what keepers send.
    uint256 internal constant CAP = BATCH_GAS;

    SpdexVaultBatcher internal batcher;
    address internal rewardTo;
    /// The gas the last batch sent with `sendWithGasKept` had left when it returned.
    uint256 internal lastSpare;
    /// The gas `sendWithGas` and `sendWithGasKept` give each vault.
    uint256 internal sendCap = CAP;

    function setUp() public override {
        super.setUp();
        batcher = deployBatcher();
        rewardTo = fresh("reward-to");
        // A community keeper's address: the vaults below are made due at once, inside their
        // windows. The window's own tests are at the end of this file and in `Window.t.sol`.
        makeEligible(rewardTo);
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────────

    function list1(address a) internal pure returns (address[] memory l) {
        l = new address[](1);
        l[0] = a;
    }

    function list2(address a, address b) internal pure returns (address[] memory l) {
        l = new address[](2);
        (l[0], l[1]) = (a, b);
    }

    function list3(address a, address b, address c) internal pure returns (address[] memory l) {
        l = new address[](3);
        (l[0], l[1], l[2]) = (a, b, c);
    }

    function reasons2(bytes4 a, bytes4 b) internal pure returns (bytes4[] memory r) {
        r = new bytes4[](2);
        (r[0], r[1]) = (a, b);
    }

    function run(address[] memory vaults, uint256 minRewards)
        internal
        returns (uint256 bought, uint256 earned, bytes4[] memory reasons)
    {
        vm.prank(keeper);
        return batcher.executeBatch(vaults, rewardTo, minRewards, CAP);
    }

    function directBuy(SpdexDcaVault vault) internal {
        vm.prank(keeper);
        vault.execute(keeper);
    }

    /// A vault-shaped mock that pays `reward` WETH per call, holding enough for `calls` calls.
    function paying(uint256 reward, uint256 calls) internal returns (PayingVault vault) {
        vault = new PayingVault(WETH, reward);
        giveWeth(address(vault), reward * calls);
    }

    function giveWeth(address to, uint256 amount) internal {
        vm.deal(address(this), amount);
        IWETHTest(WETH).deposit{value: amount}();
        IWETHTest(WETH).transfer(to, amount);
    }

    /// The events `emitter` wrote with `topic`, in order.
    function logsOf(VmLog[] memory logs, address emitter, bytes32 topic) internal pure returns (VmLog[] memory found) {
        uint256 n;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == emitter && logs[i].topics[0] == topic) n++;
        }
        found = new VmLog[](n);
        n = 0;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == emitter && logs[i].topics[0] == topic) found[n++] = logs[i];
        }
    }

    function withoutSelector(bytes memory data) internal pure returns (bytes memory rest) {
        rest = new bytes(data.length - 4);
        for (uint256 i; i < rest.length; i++) {
            rest[i] = data[i + 4];
        }
    }

    /// A batch sent with exactly `gas`, then undone: whether its answer could be read (it
    /// went through, or reverted `NothingBought`), with each vault's reason.
    function sendWithGas(SpdexVaultBatcher b, address[] memory vaults, address to, uint256 gas)
        internal
        returns (bool readable, bool ok, bytes4[] memory reasons)
    {
        uint256 snapshot = vmb.snapshotState();
        (ok, reasons, readable) = sendWithGasKept(b, vaults, to, gas);
        uint256 spare = lastSpare;
        vmb.revertToState(snapshot);
        lastSpare = spare;
    }

    /// The same, kept.
    function sendWithGasKept(SpdexVaultBatcher b, address[] memory vaults, address to, uint256 gas)
        internal
        returns (bool ok, bytes4[] memory reasons, bool readable)
    {
        // Every account cold, as at the start of a transaction, so each try sees the same costs.
        vmb.cool(address(b));
        vmb.cool(WETH);
        vmb.cool(to);
        for (uint256 i; i < vaults.length; i++) {
            vmb.cool(vaults[i]);
        }
        bytes memory returned;
        vm.prank(keeper);
        (ok, returned) =
            address(b).call{gas: gas}(abi.encodeCall(SpdexVaultBatcher.executeBatch, (vaults, to, uint256(0), sendCap)));
        lastSpare = vmb.lastCallGas().gasRemaining;
        if (ok) {
            (,, reasons) = abi.decode(returned, (uint256, uint256, bytes4[]));
            readable = true;
        } else if (returned.length >= 4 && bytes4(returned) == SpdexVaultBatcher.NothingBought.selector) {
            reasons = abi.decode(withoutSelector(returned), (bytes4[]));
            readable = true;
        }
    }

    /// What the batcher must have left before an attempt with `sendCap`: the cap after the
    /// 63/64 rule, and `ATTEMPT_OVERHEAD`.
    function minGasPerAttempt(SpdexVaultBatcher b) internal view returns (uint256) {
        return sendCap + (sendCap + 62) / 63 + b.ATTEMPT_OVERHEAD();
    }

    /// The least gas a batch can be sent with for `vaults[index]` to be attempted: below it,
    /// the batcher sees less than `minGasPerAttempt` before that vault, calls it `NotTried`,
    /// and finishes. At it, the batcher sees exactly `minGasPerAttempt` there.
    function leastGasToTry(SpdexVaultBatcher b, address[] memory vaults, uint256 index, address to)
        internal
        returns (uint256)
    {
        // At the minimum itself, even the first vault is not tried: the call's own setup
        // comes out of it first.
        uint256 low = minGasPerAttempt(b);
        uint256 high = 1_000_000 + vaults.length * (sendCap + 200_000);
        (bool readable,, bytes4[] memory reasons) = sendWithGas(b, vaults, to, low);
        assertTrue(readable && reasons[index] == SpdexVaultBatcher.NotTried.selector, "not tried at the minimum");
        (readable,, reasons) = sendWithGas(b, vaults, to, high);
        assertTrue(readable && reasons[index] != SpdexVaultBatcher.NotTried.selector, "tried with plenty");
        while (low + 1 < high) {
            uint256 middle = (low + high) / 2;
            (readable,, reasons) = sendWithGas(b, vaults, to, middle);
            if (readable && reasons[index] == SpdexVaultBatcher.NotTried.selector) low = middle;
            else high = middle;
        }
        return high;
    }

    // ─── Buying and paying ───────────────────────────────────────────────────────

    function test_buysEveryDueVaultAndEachPaysRewardToDirectly() public {
        Plan memory p = defaultPlan();
        SpdexDcaVault a = createFunded(p);
        SpdexDcaVault b = createFunded(p);
        SpdexDcaVault c = createFunded(p);

        vm.recordLogs();
        (uint256 bought, uint256 earned, bytes4[] memory reasons) = run(list3(address(a), address(b), address(c)), 0);
        VmLog[] memory logs = vm.getRecordedLogs();

        assertEq(bought, 3, "all three bought");
        assertEq(earned, 3 * p.keeperReward, "earned every reward");
        for (uint256 i; i < 3; i++) {
            assertEq(reasons[i], bytes4(0), "no reason where a vault bought");
        }
        assertEq(a.buysDone() + b.buysDone() + c.buysDone(), 3, "one buy each");
        assertEq(a.windowBuys() + b.windowBuys() + c.windowBuys(), 3, "each inside its window, by a holder");
        assertEq(wethOf(rewardTo), 3 * p.keeperReward, "rewardTo received every reward");
        assertEq(wethOf(keeper), 0, "the caller received nothing it did not name");

        // Every reward went from its vault to rewardTo, and no WETH moved to or from the batcher.
        assertEq(
            rewardsPaidDirectly(logs, [address(a), address(b), address(c)], p.keeperReward),
            3,
            "three rewards, one from each vault"
        );

        VmLog[] memory batch = logsOf(logs, address(batcher), BATCH_TOPIC);
        assertEq(batch.length, 1, "one Batch");
        assertEq(address(uint160(uint256(batch[0].topics[1]))), keeper, "caller, indexed");
        assertEq(address(uint160(uint256(batch[0].topics[2]))), rewardTo, "rewardTo, indexed");
        assertEq(batch[0].data, abi.encode(uint256(3), uint256(3), uint256(3), 3 * p.keeperReward), "its figures");
    }

    /// How many WETH transfers to `rewardTo` in `logs` came from `vaults`, in order, each of
    /// `reward`; and that no WETH moved to or from the batcher.
    function rewardsPaidDirectly(VmLog[] memory logs, address[3] memory vaults, uint256 reward)
        internal
        view
        returns (uint256 seen)
    {
        VmLog[] memory transfers = logsOf(logs, WETH, TRANSFER_TOPIC);
        for (uint256 i; i < transfers.length; i++) {
            address from = address(uint160(uint256(transfers[i].topics[1])));
            address to = address(uint160(uint256(transfers[i].topics[2])));
            assertTrue(from != address(batcher) && to != address(batcher), "no WETH through the batcher");
            if (to != rewardTo) continue;
            assertEq(from, vaults[seen], "paid by the vault itself, in the batch's order");
            assertEq(abi.decode(transfers[i].data, (uint256)), reward, "its reward");
            seen++;
        }
    }

    /// `earned` is how much `rewardTo`'s WETH rose during the batch — not what the vaults
    /// report paying, which no factory vouches for any more — and `minRewards` is held against
    /// that. A vault that answers like a buy and claims a reward it never paid counts as a buy,
    /// since it answered like one, and adds nothing to `earned`.
    function test_earnedIsWhatRewardToReceivedNotWhatTheVaultsClaim() public {
        PayingVault small = paying(1_000, 2);
        LyingVault liar = new LyingVault();
        PayingVault large = paying(2_500, 2);
        address[] memory vaults = list3(address(small), address(liar), address(large));

        bytes4[] memory none = new bytes4[](3);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SpdexVaultBatcher.TooLittle.selector, 3_500, 3_501, none));
        batcher.executeBatch(vaults, rewardTo, 3_501, CAP);

        vm.recordLogs();
        vm.prank(keeper);
        (uint256 bought, uint256 earned,) = batcher.executeBatch(vaults, rewardTo, 3_500, CAP);
        VmLog[] memory batch = logsOf(vm.getRecordedLogs(), address(batcher), BATCH_TOPIC);
        assertEq(bought, 3, "the liar answered like a buy, so it counts as one");
        assertEq(earned, 3_500, "but earned is the two rewards rewardTo actually received");
        assertEq(batch[0].data, abi.encode(uint256(3), uint256(3), uint256(3), uint256(3_500)), "and Batch says so");
        assertEq(wethOf(rewardTo), 3_500, "which rewardTo received, from the vaults");
        assertEq(wethOf(address(batcher)), 0, "none of it through the batcher");
    }

    /// WETH `rewardTo` held before the batch is not earned by it: `earned` is the rise alone.
    function test_earnedIgnoresWhatRewardToAlreadyHeld() public {
        giveWeth(rewardTo, 5 ether);
        Plan memory p = defaultPlan();
        SpdexDcaVault a = createFunded(p);
        (, uint256 earned,) = run(list1(address(a)), 0);
        assertEq(earned, p.keeperReward, "the one reward");
        assertEq(wethOf(rewardTo), 5 ether + p.keeperReward, "on top of what it held");
    }

    function test_holdsNothingAfterABatch() public {
        Plan memory p = defaultPlan();
        SpdexDcaVault a = createFunded(p);
        SpdexDcaVault b = createFunded(p);
        run(list2(address(a), address(b)), 0);
        assertEq(wethOf(address(batcher)), 0, "no WETH left");
        assertEq(address(batcher).balance, 0, "no ether either");
    }

    /// The batcher is bound to no factory: which vaults are worth calling is its caller's to
    /// know. A clone made by hand, with the same code and terms, funded and due, is triggered
    /// like the factory's own, and pays `rewardTo` the same. (Keepers and the app list only
    /// vaults a listed factory vouches for; a report counts only those vaults' `Bought` logs.)
    function test_aVaultNoFactoryVouchesForIsTriggeredLikeAnyOther() public {
        Plan memory p = defaultPlan();
        SpdexDcaVault a = createFunded(p);
        SpdexDcaVault byHand = handMadeFunded(SPX, SPX_WETH_PAIR, SPX_WETH_POOL, p);
        SpdexDcaVault b = createFunded(p);
        assertTrue(!factory.isVault(address(byHand)), "nothing vouches for it");

        (uint256 bought, uint256 earned, bytes4[] memory reasons) =
            run(list3(address(a), address(byHand), address(b)), 0);
        assertEq(bought, 3, "all three bought");
        assertEq(earned, 3 * p.keeperReward, "and paid rewardTo");
        assertEq(reasons[1], bytes4(0), "the hand-made one too");
        assertEq(byHand.buysDone(), 1, "it was called, and bought");
    }

    /// One batch, the vaults of two factories: what lets a later release, or a later market
    /// list, share this batcher instead of shipping one of its own.
    function test_vaultsOfTwoFactoriesBuyInOneBatch() public {
        SpdexVaultFactory other = deployFactory(spxMarkets());
        assertTrue(address(other) != address(factory), "another factory");
        Plan memory p = defaultPlan();
        SpdexDcaVault mine = createFunded(p);
        SpdexDcaVault theirs = createFundedOn(other, p);

        (uint256 bought, uint256 earned,) = run(list2(address(mine), address(theirs)), 0);
        assertEq(bought, 2, "both bought");
        assertEq(earned, 2 * p.keeperReward, "both paid rewardTo");
        assertTrue(factory.isVault(address(mine)) && other.isVault(address(theirs)), "each its own factory's");
    }

    /// A v1 vault has `execute()`, not `execute(rewardTo)`: in a batch it reverts with nothing,
    /// `EmptyRevert`, and is not called at all. v1's vaults keep v1's batcher.
    function test_aV1VaultInABatchRefusesEmpty() public {
        Plan memory p = defaultPlan();
        SpdexDcaVault a = createFunded(p);
        V1ShapedVault v1 = new V1ShapedVault();
        (uint256 bought,, bytes4[] memory reasons) = run(list2(address(v1), address(a)), 0);
        assertEq(bought, 1, "the v2 vault bought");
        assertEq(reasons[0], SpdexVaultBatcher.EmptyRevert.selector, "the v1 one refused, empty");
        assertEq(v1.calls(), 0, "its execute() never ran");
    }

    /// Each vault's gas is the caller's to give, from `MIN_EXECUTE_GAS` to `MAX_EXECUTE_GAS`,
    /// so a fork that repriced a buy past today's cap would not strand this batcher.
    function test_theGasPerVaultIsBounded() public {
        Plan memory p = defaultPlan();
        SpdexDcaVault a = createFunded(p);
        uint256 least = batcher.MIN_EXECUTE_GAS();
        uint256 most = batcher.MAX_EXECUTE_GAS();
        assertEq(least, CAP, "the least is what keepers send today");
        for (uint256 i; i < 2; i++) {
            uint256 gas = i == 0 ? least - 1 : most + 1;
            vm.prank(keeper);
            vm.expectRevert(abi.encodeWithSelector(SpdexVaultBatcher.GasOutOfRange.selector, gas, least, most));
            batcher.executeBatch(list1(address(a)), rewardTo, 0, gas);
        }
        vm.prank(keeper);
        (uint256 bought,,) = batcher.executeBatch(list1(address(a)), rewardTo, 0, 1_000_000);
        assertEq(bought, 1, "more than the least buys as well");
    }

    /// The pair pushed about 3% above the pool: a vault allowing 1% refuses, one allowing 5%
    /// buys, and the batch goes through with the refusal recorded.
    function test_aRefusalDoesNotSinkTheRest() public {
        Plan memory p = defaultPlan();
        p.maxSlippageBps = 100;
        SpdexDcaVault tight = createFunded(p);
        p.maxSlippageBps = 500;
        SpdexDcaVault loose = createFunded(p);
        pushV2(40 ether);
        (uint256 spotTight, uint256 floorTight,) = tight.quote();
        (uint256 spotLoose, uint256 floorLoose,) = loose.quote();
        assertLt(spotTight, floorTight, "outside the 1% floor");
        assertGe(spotLoose, floorLoose, "inside the 5% floor");

        (uint256 bought,, bytes4[] memory reasons) = run(list2(address(tight), address(loose)), 0);
        assertEq(bought, 1, "one bought");
        assertEq(reasons[0], SpdexDcaVault.PriceBelowFloor.selector, "the tight one refused");
        assertEq(reasons[1], bytes4(0), "the loose one bought");
        assertEq(tight.buysDone(), 0, "the refusal changed nothing");
        assertEq(loose.buysDone(), 1, "the buy happened");
        assertEq(wethOf(rewardTo), p.keeperReward, "paid for the one buy");
    }

    function test_aVaultNotDueRefusesTooSoonInsideABatch() public {
        Plan memory p = defaultPlan();
        SpdexDcaVault early = createFunded(p);
        SpdexDcaVault due = createFunded(p);
        directBuy(early);
        (uint256 bought,, bytes4[] memory reasons) = run(list2(address(early), address(due)), 0);
        assertEq(bought, 1, "the due one bought");
        assertEq(reasons[0], SpdexDcaVault.TooSoon.selector, "the other is TooSoon");
        assertEq(early.buysDone(), 1, "still its one buy");
    }

    function test_theSameVaultTwiceBuysOnce() public {
        Plan memory p = defaultPlan();
        SpdexDcaVault a = createFunded(p);
        (uint256 bought,, bytes4[] memory reasons) = run(list2(address(a), address(a)), 0);
        assertEq(bought, 1, "once");
        assertEq(reasons[1], SpdexDcaVault.TooSoon.selector, "the second is TooSoon");
        assertEq(a.buysDone(), 1, "one buy");
        assertEq(wethOf(rewardTo), p.keeperReward, "one reward");
    }

    // ─── Refusing a batch ────────────────────────────────────────────────────────

    function test_nothingBoughtRevertsWithEveryReason() public {
        Plan memory p = defaultPlan();
        SpdexDcaVault a = createFunded(p);
        SpdexDcaVault b = createFunded(p);
        directBuy(a);
        directBuy(b);
        // An account in the list: the call to it succeeds with nothing, which is not a buy.
        bytes4[] memory expected = new bytes4[](3);
        expected[0] = SpdexDcaVault.TooSoon.selector;
        expected[1] = SpdexDcaVault.TooSoon.selector;
        expected[2] = SpdexVaultBatcher.EmptyReturn.selector;
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SpdexVaultBatcher.NothingBought.selector, expected));
        batcher.executeBatch(list3(address(a), address(b), stranger), rewardTo, 0, CAP);
    }

    function test_anEmptyListRevertsNothingBought() public {
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SpdexVaultBatcher.NothingBought.selector, new bytes4[](0)));
        batcher.executeBatch(new address[](0), rewardTo, 0, CAP);
    }

    /// Another keeper took one of the two first: the caller asked for both rewards, so the
    /// batch does not happen, and the buy it would have made is undone with it.
    function test_tooLittleRevertsWithEveryReason() public {
        Plan memory p = defaultPlan();
        SpdexDcaVault due = createFunded(p);
        SpdexDcaVault taken = createFunded(p);
        directBuy(taken);
        uint256 both = 2 * p.keeperReward;
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                SpdexVaultBatcher.TooLittle.selector,
                p.keeperReward,
                both,
                reasons2(bytes4(0), SpdexDcaVault.TooSoon.selector)
            )
        );
        batcher.executeBatch(list2(address(due), address(taken)), rewardTo, both, CAP);
        assertEq(due.buysDone(), 0, "the buy it made is rolled back");
        assertEq(wethOf(rewardTo), 0, "nothing paid");
    }

    function test_minRewardsZeroIsTodaysBehaviour() public {
        Plan memory p = defaultPlan();
        SpdexDcaVault due = createFunded(p);
        SpdexDcaVault taken = createFunded(p);
        directBuy(taken);
        uint256 snapshot = vmb.snapshotState();
        (uint256 bought, uint256 earned,) = run(list2(address(due), address(taken)), 0);
        assertEq(bought, 1, "lands with one bought");
        assertEq(earned, p.keeperReward, "and its reward");
        vmb.revertToState(snapshot);
        // Exactly what it earns is enough.
        (bought,,) = run(list2(address(due), address(taken)), p.keeperReward);
        assertEq(bought, 1, "a minimum it meets exactly lands too");
    }

    /// WETH sent to the batcher by mistake counts for nothing: not as earned, not towards the
    /// caller's minimum, and it is not paid on. v1 swept it to `rewardTo` with the rewards and
    /// reported it apart (`Batch.swept`); v2's batcher never handles WETH at all, so it stays
    /// where it was sent.
    function test_strayWethIsNeitherEarnedNorPaidOn() public {
        Plan memory p = defaultPlan();
        SpdexDcaVault a = createFunded(p);
        SpdexDcaVault b = createFunded(p);
        uint256 stray = 0.123 ether;
        giveWeth(address(batcher), stray);
        uint256 rewards = 2 * p.keeperReward;

        // Stray WETH never counts towards the caller's minimum.
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                SpdexVaultBatcher.TooLittle.selector, rewards, rewards + 1, reasons2(bytes4(0), bytes4(0))
            )
        );
        batcher.executeBatch(list2(address(a), address(b)), rewardTo, rewards + 1, CAP);

        vm.recordLogs();
        (, uint256 earned,) = run(list2(address(a), address(b)), rewards);
        VmLog[] memory batch = logsOf(vm.getRecordedLogs(), address(batcher), BATCH_TOPIC);
        assertEq(earned, rewards, "earned is the rewards alone");
        (,,, uint256 loggedEarned) = abi.decode(batch[0].data, (uint256, uint256, uint256, uint256));
        assertEq(loggedEarned, rewards, "Batch.earned is the rewards alone");
        assertEq(wethOf(rewardTo), rewards, "rewardTo received the rewards, and only them");
        assertEq(wethOf(address(batcher)), stray, "the stray WETH did not move");
    }

    /// A batch never pays the batcher (`test_rewardToMustBeSomeoneElse`), but a direct
    /// caller of a vault may name any `rewardTo` after its window, this contract included:
    /// that fee then stays here for good, since nothing here sends WETH. It is the caller's
    /// own fee, lost by its own choice, and later batches neither count it nor pay it on.
    /// Inside a window the batcher cannot be named at all: it is a contract, and only
    /// accounts are eligible.
    function test_aFeeNamedToTheBatcherByADirectCallerStaysThere() public {
        Plan memory p = defaultPlan();
        SpdexDcaVault a = createFunded(p);
        SpdexDcaVault b = createFunded(p);
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(SpdexDcaVault.NotEligible.selector, address(batcher), p.startAt + p.communityWindow)
        );
        a.execute(address(batcher));

        vm.warp(p.startAt + p.communityWindow);
        vm.prank(stranger);
        a.execute(address(batcher));
        assertEq(wethOf(address(batcher)), p.keeperReward, "paid to the batcher");

        (, uint256 earned,) = run(list1(address(b)), 0);
        assertEq(earned, p.keeperReward, "a later batch earns its own vault's reward alone");
        assertEq(wethOf(rewardTo), p.keeperReward, "and pays rewardTo that alone");
        assertEq(wethOf(address(batcher)), p.keeperReward, "the fee stays where it was paid");
    }

    function test_rewardToMustBeSomeoneElse() public {
        Plan memory p = defaultPlan();
        SpdexDcaVault a = createFunded(p);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SpdexVaultBatcher.BadRewardTo.selector, address(0)));
        batcher.executeBatch(list1(address(a)), address(0), 0, CAP);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SpdexVaultBatcher.BadRewardTo.selector, address(batcher)));
        batcher.executeBatch(list1(address(a)), address(batcher), 0, CAP);
        assertEq(a.buysDone(), 0, "nothing bought");
    }

    function test_tooManyVaultsIsRefused() public {
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SpdexVaultBatcher.TooManyVaults.selector, 151, 150));
        batcher.executeBatch(new address[](151), rewardTo, 0, CAP);
    }

    // ─── What a vault can do to a batch ──────────────────────────────────────────

    /// A success that answers less than `execute`'s two words — nothing at all, or one word,
    /// which is what a v1 vault answered — is not a buy, and pays nothing towards `earned`.
    function test_aSuccessWithoutReturnDataIsNotBought() public {
        SilentVault silent = new SilentVault();
        OneWordVault oneWord = new OneWordVault();
        PayingVault payer = paying(1_000, 1);

        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                SpdexVaultBatcher.NothingBought.selector, reasonsOf(SpdexVaultBatcher.EmptyReturn.selector)
            )
        );
        batcher.executeBatch(list1(address(silent)), rewardTo, 0, CAP);
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                SpdexVaultBatcher.NothingBought.selector, reasonsOf(SpdexVaultBatcher.EmptyReturn.selector)
            )
        );
        batcher.executeBatch(list1(address(oneWord)), rewardTo, 0, CAP);

        vm.recordLogs();
        vm.prank(keeper);
        (uint256 bought, uint256 earned, bytes4[] memory reasons) =
            batcher.executeBatch(list3(address(silent), address(oneWord), address(payer)), rewardTo, 0, CAP);
        VmLog[] memory skipped = logsOf(vm.getRecordedLogs(), address(batcher), NOT_TRIGGERED_TOPIC);
        assertEq(bought, 1, "only the paying one counts");
        assertEq(earned, 1_000, "and only its reward");
        assertEq(reasons[0], SpdexVaultBatcher.EmptyReturn.selector, "EmptyReturn");
        assertEq(reasons[1], SpdexVaultBatcher.EmptyReturn.selector, "EmptyReturn for one word too");
        assertEq(silent.calls(), 1, "it was called, and succeeded");
        assertEq(oneWord.calls(), 1, "so was the other");
        assertEq(skipped.length, 2, "two NotTriggered");
        assertEq(skipped[0].topics[2], bytes32(SpdexVaultBatcher.EmptyReturn.selector), "EmptyReturn, indexed");
        assertGt(abi.decode(skipped[0].data, (uint256)), 0, "with the gas it cost");
    }

    function reasonsOf(bytes4 a) internal pure returns (bytes4[] memory r) {
        r = new bytes4[](1);
        r[0] = a;
    }

    /// Each vault is given exactly the gas the caller asked for, the last one included, in a
    /// batch sent with just enough gas for the last to be attempted: the cap after the 63/64
    /// rule and `ATTEMPT_OVERHEAD` are enough. At the least cap, and at a larger one.
    function test_eachAttemptGetsExactlyTheCap() public {
        eachAttemptGetsExactly(CAP);
    }

    function test_eachAttemptGetsExactlyALargerCap() public {
        eachAttemptGetsExactly(1_000_000);
    }

    function eachAttemptGetsExactly(uint256 cap) internal {
        sendCap = cap;
        // What a probe sees on entry when called with exactly the cap: the cap, less its own
        // dispatch before it reads the gas.
        GasProbe yardstick = new GasProbe();
        (bool called,) = address(yardstick).call{gas: cap}(abi.encodeCall(GasProbe.execute, (rewardTo)));
        assertTrue(called, "the yardstick probe ran");
        uint256 withTheCap = yardstick.seen();
        assertGt(withTheCap, cap - 300, "a probe's own dispatch, its argument included, is a few dozen opcodes");

        GasProbe[] memory probes = new GasProbe[](3);
        address[] memory vaults = new address[](3);
        for (uint256 i; i < 3; i++) {
            probes[i] = new GasProbe();
            vaults[i] = address(probes[i]);
        }
        uint256 gas = leastGasToTry(batcher, vaults, 2, rewardTo);
        console.log("least gas for three probes to be tried", gas);
        (bool ok, bytes4[] memory reasons,) = sendWithGasKept(batcher, vaults, rewardTo, gas);
        assertTrue(ok, "the batch went through");
        for (uint256 i; i < 3; i++) {
            assertEq(reasons[i], bytes4(0), "each probe answered like a buy");
            assertEq(probes[i].seen(), withTheCap, "every attempt had exactly the cap");
        }
    }

    /// The worst end for a batch: its last attempt burns the whole cap with only
    /// the least gas an attempt needs left before it, after a reward paid to a `rewardTo` that has
    /// never held WETH. It still finishes. (In v1 the batcher paid that first reward itself,
    /// at the end; in v2 the vault pays it, inside its own capped call, and the end is
    /// cheaper.)
    function test_theBatchFinishesWhenTheLastAttemptBurnsTheCap() public {
        PayingVault payer = paying(1_000, 1);
        GasBurner burner = new GasBurner();
        address freshRewardTo = fresh("fresh-reward-to");
        address[] memory vaults = list2(address(payer), address(burner));

        uint256 gas = leastGasToTry(batcher, vaults, 1, freshRewardTo);
        vm.recordLogs();
        (bool ok, bytes4[] memory reasons,) = sendWithGasKept(batcher, vaults, freshRewardTo, gas);
        console.log("gas to spare when a batch's last attempt burns the cap", lastSpare);
        assertTrue(ok, "it finished");
        assertEq(reasons[1], SpdexVaultBatcher.EmptyRevert.selector, "the burner was tried, and burned");
        assertEq(logsOf(vm.getRecordedLogs(), address(batcher), BATCH_TOPIC).length, 1, "and said so in Batch");
        assertEq(wethOf(freshRewardTo), 1_000, "the reward reached the fresh rewardTo");
    }

    /// The same end for the longest list: 150 vaults that each burn the cap, the last with
    /// only the least gas an attempt needs left before it, still revert `NothingBought` with every
    /// reason rather than run out of gas encoding them.
    ///
    /// Searching for that gas with 150 burners would burn 60 million gas a try, more than a
    /// test may. So the search runs on a list whose first 149 refuse at once instead: every
    /// attempt costs the batcher the same but for what the vault itself spends, so the
    /// burners' list needs exactly 149 × (the cap − a bare refusal's own gas) more. The two
    /// sends on the real list — at that gas, and one less — show the figure is exact.
    function test_theLongestListStillRevertsWithEveryReasonWhenTheLastBurnsTheCap() public {
        uint256 n = batcher.MAX_VAULTS();
        address[] memory burners = new address[](n);
        address[] memory cheap = new address[](n);
        for (uint256 i; i < n; i++) {
            burners[i] = address(new GasBurner());
            if (i + 1 < n) {
                cheap[i] = address(new BareRevert());
            }
        }
        cheap[n - 1] = burners[n - 1];

        (bool refused,) = cheap[0].call{gas: CAP}("");
        assertTrue(!refused, "a bare refusal refuses");
        uint256 bareOwnGas = vmb.lastCallGas().gasTotalUsed;
        uint256 gas = leastGasToTry(batcher, cheap, n - 1, rewardTo) + (n - 1) * (CAP - bareOwnGas);
        console.log("least gas for 150 burners to be tried", gas);

        (bool readable, bool ok, bytes4[] memory reasons) = sendWithGas(batcher, burners, rewardTo, gas);
        console.log("gas to spare when the longest list's last attempt burns the cap", lastSpare);
        assertTrue(readable && !ok, "NothingBought, with its reasons, not an out-of-gas");
        for (uint256 i; i < n; i++) {
            assertEq(reasons[i], SpdexVaultBatcher.EmptyRevert.selector, "every burner tried");
        }
        (readable, ok, reasons) = sendWithGas(batcher, burners, rewardTo, gas - 1);
        assertTrue(readable && reasons[n - 1] == SpdexVaultBatcher.NotTried.selector, "one gas less, the last is not");
    }

    /// The end that costs a batch most is not the last attempt burning the cap but an early
    /// one: after it, every vault left is marked `NotTried` before the batch finishes. The
    /// longest list whose first vault burns its cap with only the least gas an attempt needs left
    /// before it marks the other 149, and still reverts `NothingBought` with every reason
    /// rather than run out of gas encoding them.
    function test_aLongListWhoseFirstAttemptBurnsTheCapStillRevertsWithEveryReason() public {
        uint256 n = batcher.MAX_VAULTS();
        address[] memory vaults = new address[](n);
        vaults[0] = address(new GasBurner());
        for (uint256 i = 1; i < n; i++) {
            vaults[i] = address(new BareRevert());
        }
        for (uint256 i; i < n; i++) {
        }

        uint256 gas = leastGasToTry(batcher, vaults, 0, rewardTo);
        (bool readable, bool ok, bytes4[] memory reasons) = sendWithGas(batcher, vaults, rewardTo, gas);
        console.log("gas to spare when the first of 150 burns the cap and 149 are not tried", lastSpare);
        assertTrue(readable && !ok, "NothingBought, with its reasons, not an out-of-gas");
        assertEq(reasons[0], SpdexVaultBatcher.EmptyRevert.selector, "the burner was tried, and burned");
        for (uint256 i = 1; i < n; i++) {
            assertEq(reasons[i], SpdexVaultBatcher.NotTried.selector, "every other vault not tried");
        }
    }

    /// The same on the way out of a batch that bought: one vault pays a `rewardTo` that has
    /// never held WETH, the next burns its cap with only the least gas an attempt needs left before
    /// it, and the other 148 are marked `NotTried`. The batch still emits `Batch` and returns
    /// all 150 reasons, so the buy that was made stands.
    function test_aLongListWhoseSecondAttemptBurnsTheCapStillFinishesWithItsBuy() public {
        uint256 n = batcher.MAX_VAULTS();
        address[] memory vaults = new address[](n);
        vaults[0] = address(paying(1_000, 1));
        vaults[1] = address(new GasBurner());
        for (uint256 i = 2; i < n; i++) {
            vaults[i] = address(new BareRevert());
        }
        address freshRewardTo = fresh("fresh-reward-to");

        uint256 gas = leastGasToTry(batcher, vaults, 1, freshRewardTo);
        vm.recordLogs();
        (bool ok, bytes4[] memory reasons,) = sendWithGasKept(batcher, vaults, freshRewardTo, gas);
        console.log("gas to spare when the second of 150 burns the cap and 148 are not tried", lastSpare);
        assertTrue(ok, "it finished");
        assertEq(reasons[0], bytes4(0), "the first bought");
        assertEq(reasons[1], SpdexVaultBatcher.EmptyRevert.selector, "the burner was tried, and burned");
        for (uint256 i = 2; i < n; i++) {
            assertEq(reasons[i], SpdexVaultBatcher.NotTried.selector, "every other vault not tried");
        }
        assertEq(logsOf(vm.getRecordedLogs(), address(batcher), BATCH_TOPIC).length, 1, "and said so in Batch");
        assertEq(wethOf(freshRewardTo), 1_000, "the reward reached the fresh rewardTo");
    }

    function test_whenGasRunsShortTheRestAreNotTriedNotFailed() public {
        PayingVault payer = paying(1_000, 1);
        GasProbe second = new GasProbe();
        GasProbe third = new GasProbe();
        address[] memory vaults = list3(address(payer), address(second), address(third));

        uint256 gas = leastGasToTry(batcher, vaults, 1, rewardTo) - 1;
        vm.recordLogs();
        (bool ok, bytes4[] memory reasons,) = sendWithGasKept(batcher, vaults, rewardTo, gas);
        VmLog[] memory logs = vm.getRecordedLogs();
        assertTrue(ok, "the batch went through");
        assertEq(reasons[0], bytes4(0), "the first bought");
        assertEq(reasons[1], SpdexVaultBatcher.NotTried.selector, "the second was not tried");
        assertEq(reasons[2], SpdexVaultBatcher.NotTried.selector, "nor the third");
        assertEq(second.seen() + third.seen(), 0, "neither was called");
        assertEq(logsOf(logs, address(batcher), NOT_TRIGGERED_TOPIC).length, 0, "and no event says they failed");
        VmLog[] memory batch = logsOf(logs, address(batcher), BATCH_TOPIC);
        (uint256 listed, uint256 tried, uint256 bought,) =
            abi.decode(batch[0].data, (uint256, uint256, uint256, uint256));
        assertEq(listed, 3, "three listed");
        assertEq(tried, 1, "one tried");
        assertEq(bought, 1, "one bought");
    }

    function test_aVaultThatBurnsItsGasCostsAtMostTheCap() public {
        PayingVault payer = paying(1_000, 1);
        GasBurner burner = new GasBurner();
        vm.recordLogs();
        vm.prank(keeper);
        batcher.executeBatch(list2(address(payer), address(burner)), rewardTo, 0, CAP);
        VmLog[] memory skipped = logsOf(vm.getRecordedLogs(), address(batcher), NOT_TRIGGERED_TOPIC);
        assertEq(skipped.length, 1, "one NotTriggered");
        assertEq(skipped[0].topics[2], bytes32(SpdexVaultBatcher.EmptyRevert.selector), "EmptyRevert");
        uint256 used = abi.decode(skipped[0].data, (uint256));
        console.log("a vault that burns its gas cost the batch", used);
        assertGe(used, CAP, "it burned its whole cap");
        assertLt(used, CAP + 3_001, "and not much more");
    }

    /// A vault that answers a refusal with 256 KB costs the batch its own gas and nothing
    /// more: the batcher reads 4 bytes of it, the same as of a 4-byte refusal.
    function test_aHugeRevertIsNotCopied() public {
        PayingVault payer = paying(1_000, 2);
        ReturnBomb bomb = new ReturnBomb(256 * 1024);
        ReturnBomb small = new ReturnBomb(4);

        (uint256 bombAttempt, bytes4 bombReason) = attemptGas(address(payer), address(bomb));
        (uint256 smallAttempt, bytes4 smallReason) = attemptGas(address(payer), address(small));
        assertEq(bombReason, bytes4(0xdeadbeef), "its first 4 bytes are the reason");
        assertEq(smallReason, bytes4(0xdeadbeef), "the same for the small one");

        // What the vault itself spends, measured on its own.
        uint256 bombOwn = ownGas(address(bomb));
        uint256 smallOwn = ownGas(address(small));
        // Memory from the three words Solidity starts with (to its free-memory pointer at 0x40)
        // to 8,192: 3 × 8,192 + 8,192² / 512 − 3 × 3.
        assertEq(bombOwn - smallOwn, 155_639, "the bomb pays for its own memory");
        console.log("the batcher's own share of a 256 KB refusal", bombAttempt - bombOwn);
        console.log("the batcher's own share of a 4-byte refusal", smallAttempt - smallOwn);
        assertEq(bombAttempt - bombOwn, smallAttempt - smallOwn, "the batcher pays the same for both");
        assertLt(bombAttempt - bombOwn, 5_000, "which is the call and 4 bytes");
    }

    /// The gas `vault`'s attempt cost a batch of [payer, vault], from its `NotTriggered`.
    function attemptGas(address payer, address vault)
        internal
        returns (uint256 used, bytes4 reason)
    {
        uint256 snapshot = vmb.snapshotState();
        vmb.cool(vault);
        vm.recordLogs();
        vm.prank(keeper);
        batcher.executeBatch(list2(payer, vault), rewardTo, 0, CAP);
        VmLog[] memory skipped = logsOf(vm.getRecordedLogs(), address(batcher), NOT_TRIGGERED_TOPIC);
        assertEq(skipped.length, 1, "one NotTriggered");
        used = abi.decode(skipped[0].data, (uint256));
        reason = bytes4(skipped[0].topics[2]);
        vmb.revertToState(snapshot);
    }

    /// The gas a call to `vault.execute(rewardTo)` spends inside `vault`, from its side.
    function ownGas(address vault) internal returns (uint256) {
        (bool ok,) = vault.call{gas: CAP}(abi.encodeCall(ReturnBomb.execute, (rewardTo)));
        assertTrue(!ok, "it refuses");
        return vmb.lastCallGas().gasTotalUsed;
    }

    function test_reenteringTheBatcherIsRefusedAndStealsNothing() public {
        PayingVault payer = paying(1_000, 2);
        ReenteringVault thief = new ReenteringVault(WETH);
        giveWeth(address(thief), 1);
        address attacker = fresh("attacker");
        thief.aim(IBatcherMock(address(batcher)), list1(address(payer)), attacker);

        vm.prank(keeper);
        (uint256 bought, uint256 earned,) = batcher.executeBatch(list2(address(payer), address(thief)), rewardTo, 0, CAP);
        assertEq(thief.innerRevert(), abi.encodeWithSelector(SpdexVaultBatcher.Reentrancy.selector), "Reentrancy");
        assertEq(bought, 2, "the outer batch went on");
        assertEq(earned, 1_001, "and earned both rewards");
        assertEq(wethOf(attacker), 0, "the nested batch took nothing");
        assertEq(wethOf(rewardTo), 1_001, "the outer rewardTo got every reward");
        assertEq(wethOf(address(payer)), 1_000, "and the payer paid once, not twice");
    }

    function test_etherSentToTheBatcherIsRefused() public {
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        (bool ok,) = address(batcher).call{value: 1}("");
        assertTrue(!ok, "a plain transfer reverts");
        vm.prank(stranger);
        (ok,) = address(batcher).call{value: 1}(
            abi.encodeCall(SpdexVaultBatcher.executeBatch, (new address[](0), rewardTo, 0, CAP))
        );
        assertTrue(!ok, "and so does ether with a batch");
        assertEq(address(batcher).balance, 0, "it holds none");
    }

    function test_eventsCarryTheirFigures() public {
        Plan memory p = defaultPlan();
        SpdexDcaVault due = createFunded(p);
        SpdexDcaVault early = createFunded(p);
        directBuy(early);

        vm.recordLogs();
        run(list3(address(due), address(early), stranger), 0);
        VmLog[] memory logs = vm.getRecordedLogs();

        // Triggered is the log right after its vault's Bought, and carries what the owner received.
        uint256 boughtAt = type(uint256).max;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == address(due) && logs[i].topics[0] == BOUGHT_TOPIC) boughtAt = i;
        }
        assertLt(boughtAt, logs.length - 1, "a Bought, with a log after it");
        VmLog memory triggered = logs[boughtAt + 1];
        assertEq(triggered.emitter, address(batcher), "from the batcher");
        assertEq(triggered.topics[0], TRIGGERED_TOPIC, "Triggered");
        assertEq(address(uint160(uint256(triggered.topics[1]))), address(due), "vault, indexed");
        (, uint256 amountOut, uint256 reward,,,,) =
            abi.decode(logs[boughtAt].data, (uint256, uint256, uint256, uint256, uint256, uint256, uint256));
        (uint256 received, uint256 gasUsed) = abi.decode(triggered.data, (uint256, uint256));
        assertEq(received, amountOut, "received is Bought.amountOut");
        assertGt(gasUsed, 0, "with its gas");
        assertLt(gasUsed, CAP + 3_001, "within the cap");

        VmLog[] memory refused = logsOf(logs, address(batcher), NOT_TRIGGERED_TOPIC);
        assertEq(refused.length, 2, "two NotTriggered, in order");
        assertEq(address(uint160(uint256(refused[0].topics[1]))), address(early), "the early one");
        assertEq(refused[0].topics[2], bytes32(SpdexDcaVault.TooSoon.selector), "TooSoon, indexed");
        assertGt(abi.decode(refused[0].data, (uint256)), 0, "it cost gas");
        assertEq(address(uint160(uint256(refused[1].topics[1]))), stranger, "the account");
        assertEq(refused[1].topics[2], bytes32(SpdexVaultBatcher.EmptyReturn.selector), "EmptyReturn");
        assertGt(abi.decode(refused[1].data, (uint256)), 0, "it cost the call");

        VmLog[] memory batch = logsOf(logs, address(batcher), BATCH_TOPIC);
        assertEq(batch.length, 1, "one Batch");
        assertEq(batch[0].data, abi.encode(uint256(3), uint256(3), uint256(1), reward), "3 listed, 3 tried, 1 bought");
        assertEq(logs[logs.length - 1].topics[0], BATCH_TOPIC, "Batch is the last log");
    }

    // ─── The community window ────────────────────────────────────────────────────

    /// Two vaults due now, both inside their community windows, and a `rewardTo` the registry
    /// does not find eligible: each vault refuses it (`NotEligible`), the batch buys nothing,
    /// and it reverts with each refusal — which a private relay drops for free, as it drops a
    /// lost race. The batcher adds no check of its own: the vaults decide.
    function test_anInWindowBatchForAnIneligibleRewardToBuysNothing() public {
        Plan memory p = defaultPlan();
        SpdexDcaVault a = createFunded(p);
        SpdexDcaVault b = createFunded(p);
        address outsider = fresh("outsider");

        bytes4[] memory expected = reasons2(SpdexDcaVault.NotEligible.selector, SpdexDcaVault.NotEligible.selector);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SpdexVaultBatcher.NothingBought.selector, expected));
        batcher.executeBatch(list2(address(a), address(b)), outsider, 0, CAP);
        assertEq(a.buysDone() + b.buysDone(), 0, "nothing bought");
        assertEq(wethOf(outsider), 0, "nothing paid");

        // Once the windows end, the same batch for the same address goes through.
        vm.warp(p.startAt + p.communityWindow);
        vm.prank(keeper);
        (uint256 bought, uint256 earned,) = batcher.executeBatch(list2(address(a), address(b)), outsider, 0, CAP);
        assertEq(bought, 2, "both bought after their windows");
        assertEq(earned, 2 * p.keeperReward, "and paid the outsider");
        assertEq(a.windowBuys() + b.windowBuys(), 0, "neither counted as a window buy");
    }

    /// A batch for an ineligible `rewardTo` that mixes a vault still inside its window with one
    /// past it buys only the one past it: the other refuses, and is recorded as refusing.
    function test_aMixedBatchForAnIneligibleRewardToBuysOnlyThoseAfterTheirWindow() public {
        Plan memory p = defaultPlan();
        SpdexDcaVault inside = createFunded(p);
        // Due since one window's length ago: from now, anyone may be paid for its buy.
        p.startAt = block.timestamp - p.communityWindow;
        SpdexDcaVault after_ = createFunded(p);
        (,,,,, uint256 dueSince, uint256 windowEndsAt,,) = after_.status();
        assertEq(dueSince, p.startAt, "due since its start");
        assertEq(windowEndsAt, block.timestamp, "its window ends now");
        address outsider = fresh("outsider");

        vm.recordLogs();
        vm.prank(keeper);
        (uint256 bought, uint256 earned, bytes4[] memory reasons) =
            batcher.executeBatch(list2(address(inside), address(after_)), outsider, 0, CAP);
        VmLog[] memory refused = logsOf(vm.getRecordedLogs(), address(batcher), NOT_TRIGGERED_TOPIC);
        assertEq(bought, 1, "one bought");
        assertEq(earned, p.keeperReward, "one reward");
        assertEq(reasons[0], SpdexDcaVault.NotEligible.selector, "the one inside its window refused");
        assertEq(reasons[1], bytes4(0), "the one after it bought");
        assertEq(refused.length, 1, "one NotTriggered");
        assertEq(refused[0].topics[2], bytes32(SpdexDcaVault.NotEligible.selector), "NotEligible, indexed");
        assertEq(inside.buysDone(), 0, "the refusal changed nothing");
        assertEq(after_.buysDone(), 1, "the buy happened");
        assertEq(after_.windowBuys(), 0, "after its window: not a window buy");
        assertEq(wethOf(outsider), p.keeperReward, "paid to the outsider, for the one buy");
    }

    /// A batch whose `rewardTo` owns a vault in it may make that vault's buy inside its window:
    /// the owner is always allowed. Not counted as a window buy; the fee goes back to its owner.
    function test_aBatchPayingAVaultsOwnerBuysItInsideItsWindow() public {
        Plan memory p = defaultPlan();
        SpdexDcaVault own = createFunded(p);
        uint256 before = wethOf(owner);
        vm.prank(keeper);
        (uint256 bought,,) = batcher.executeBatch(list1(address(own)), owner, 0, CAP);
        assertEq(bought, 1, "bought, inside its window");
        assertEq(own.windowBuys(), 0, "not counted: the owner's own buy");
        assertEq(wethOf(owner) - before, p.keeperReward, "the fee went back to the owner");
    }

    // ─── Where it lives ──────────────────────────────────────────────────────────

    /// Deployed through the deterministic deployer, the batcher's address depends only on its
    /// code and WETH's: not on any factory, which need not exist yet, so one address serves
    /// every release and every market list built to call it.
    function test_deployedThroughTheDeterministicDeployerLandsWhereExpected() public {
        bytes memory batcherInit = abi.encodePacked(type(SpdexVaultBatcher).creationCode, abi.encode(WETH));
        address expected = create2(BATCHER_SALT, batcherInit);

        (bool ok, bytes memory returned) = DETERMINISTIC_DEPLOYER.call(abi.encodePacked(BATCHER_SALT, batcherInit));
        assertTrue(ok, "deployed, with no factory named");
        assertEq(address(bytes20(returned)), expected, "where CREATE2 says");
        SpdexVaultBatcher deployed = SpdexVaultBatcher(expected);
        assertEq(address(deployed.weth()), WETH, "measuring mainnet's WETH");
        console.log("SpdexVaultBatcher for mainnet WETH", expected);

        // And it serves the fixture's factory's vaults, which it was never told about.
        SpdexDcaVault a = createFunded(defaultPlan());
        vm.prank(keeper);
        (uint256 bought,,) = deployed.executeBatch(list1(address(a)), rewardTo, 0, CAP);
        assertEq(bought, 1, "a vault of a factory it was never told about");

        (ok,) = DETERMINISTIC_DEPLOYER.call{gas: 5_000_000}(abi.encodePacked(BATCHER_SALT, batcherInit));
        assertTrue(!ok, "a second deployment to the same address fails");
        bytes memory otherInit = abi.encodePacked(type(SpdexVaultBatcher).creationCode, abi.encode(USDC));
        assertTrue(create2(BATCHER_SALT, otherInit) != expected, "another token, another batcher");
    }

    function create2(bytes32 salt, bytes memory initCode) internal pure returns (address) {
        return address(
            uint160(
                uint256(keccak256(abi.encodePacked(bytes1(0xff), DETERMINISTIC_DEPLOYER, salt, keccak256(initCode))))
            )
        );
    }

    function test_constructorRefusesAWethWithNoCode() public {
        vm.expectRevert(abi.encodeWithSelector(SpdexVaultBatcher.NoWeth.selector, stranger));
        new SpdexVaultBatcher(stranger);
    }
}
