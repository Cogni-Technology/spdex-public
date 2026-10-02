// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.33;

import {ForkTest, IWETHTest, Plan} from "./utils/Fork.sol";
import {VmLog, console} from "./utils/Test.sol";
import {
    BareRevert,
    GasBurner,
    GasProbe,
    IBatcherMock,
    MockVaultFactory,
    PayingVault,
    ReenteringVault,
    ReturnBomb,
    SilentVault
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

/// The batcher: it buys every due vault its factory vouches for, sends every reward to the
/// caller's `rewardTo` and keeps nothing, survives any vault's refusal, gas or answer, and
/// refuses the batches it says it refuses. Real vaults on the fork where the vault's own
/// behaviour is the point; vault-shaped mocks behind a mock factory where only a hostile or
/// odd `execute` can show it.
contract BatcherTest is ForkTest {
    VmBatcher internal constant vmb = VmBatcher(address(uint160(uint256(keccak256("hevm cheat code")))));

    bytes32 internal constant BATCH_TOPIC = keccak256("Batch(address,address,uint256,uint256,uint256,uint256,uint256)");
    bytes32 internal constant TRIGGERED_TOPIC = keccak256("Triggered(address,uint256,uint256)");
    bytes32 internal constant NOT_TRIGGERED_TOPIC = keccak256("NotTriggered(address,bytes4,uint256)");
    /// keccak256("spdex.vault.batcher.v1"): BATCHER_SALT in `src/artifacts.ts`.
    bytes32 internal constant BATCHER_SALT = keccak256("spdex.vault.batcher.v1");
    bytes32 internal constant FACTORY_SALT = keccak256("spdex.vault.factory.v1");

    uint256 internal constant CAP = 400_000;

    SpdexVaultBatcher internal batcher;
    address internal rewardTo;

    function setUp() public override {
        super.setUp();
        batcher = deployBatcher();
        rewardTo = fresh("reward-to");
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
        return batcher.executeBatch(vaults, rewardTo, minRewards);
    }

    function directBuy(SpdexDcaVault vault) internal {
        vm.prank(keeper);
        vault.execute();
    }

    /// A factory that vouches for whatever it is told to, and a batcher bound to it.
    function mockFactory() internal returns (MockVaultFactory mock, SpdexVaultBatcher bound) {
        mock = new MockVaultFactory(WETH);
        bound = new SpdexVaultBatcher(address(mock));
    }

    /// A vouched-for vault that pays `reward` WETH per call, holding enough for `calls` calls.
    function paying(MockVaultFactory mock, uint256 reward, uint256 calls) internal returns (PayingVault vault) {
        vault = new PayingVault(WETH, reward);
        giveWeth(address(vault), reward * calls);
        mock.vouch(address(vault));
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
        vmb.revertToState(snapshot);
    }

    /// The same, kept.
    function sendWithGasKept(SpdexVaultBatcher b, address[] memory vaults, address to, uint256 gas)
        internal
        returns (bool ok, bytes4[] memory reasons, bool readable)
    {
        // Every account cold, as at the start of a transaction, so each try sees the same costs.
        vmb.cool(address(b));
        vmb.cool(b.factory());
        vmb.cool(WETH);
        vmb.cool(to);
        for (uint256 i; i < vaults.length; i++) {
            vmb.cool(vaults[i]);
        }
        bytes memory returned;
        vm.prank(keeper);
        (ok, returned) =
            address(b).call{gas: gas}(abi.encodeCall(SpdexVaultBatcher.executeBatch, (vaults, to, uint256(0))));
        if (ok) {
            (,, reasons) = abi.decode(returned, (uint256, uint256, bytes4[]));
            readable = true;
        } else if (returned.length >= 4 && bytes4(returned) == SpdexVaultBatcher.NothingBought.selector) {
            reasons = abi.decode(withoutSelector(returned), (bytes4[]));
            readable = true;
        }
    }

    /// The least gas a batch can be sent with for `vaults[index]` to be attempted: below it,
    /// the batcher sees less than `MIN_GAS_PER_ATTEMPT` before that vault, calls it
    /// `NotTried`, and finishes. At it, the batcher sees exactly `MIN_GAS_PER_ATTEMPT` there.
    function leastGasToTry(SpdexVaultBatcher b, address[] memory vaults, uint256 index, address to)
        internal
        returns (uint256)
    {
        // At the minimum itself, even the first vault is not tried: the call's own setup
        // comes out of it first.
        uint256 low = b.MIN_GAS_PER_ATTEMPT();
        uint256 high = 1_000_000 + vaults.length * 600_000;
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

    function test_buysEveryDueVaultAndForwardsEveryRewardToRewardTo() public {
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
        assertEq(wethOf(rewardTo), 3 * p.keeperReward, "rewardTo received every reward");
        assertEq(wethOf(keeper), 0, "the caller received nothing it did not name");

        VmLog[] memory batch = logsOf(logs, address(batcher), BATCH_TOPIC);
        assertEq(batch.length, 1, "one Batch");
        assertEq(address(uint160(uint256(batch[0].topics[1]))), keeper, "caller, indexed");
        assertEq(address(uint160(uint256(batch[0].topics[2]))), rewardTo, "rewardTo, indexed");
        assertEq(
            batch[0].data, abi.encode(uint256(3), uint256(3), uint256(3), 3 * p.keeperReward, uint256(0)), "its figures"
        );
    }

    function test_holdsNothingAfterABatch() public {
        Plan memory p = defaultPlan();
        SpdexDcaVault a = createFunded(p);
        SpdexDcaVault b = createFunded(p);
        run(list2(address(a), address(b)), 0);
        assertEq(wethOf(address(batcher)), 0, "no WETH left");
        assertEq(address(batcher).balance, 0, "no ether either");
    }

    function test_aVaultNotFromTheFactoryIsSkippedAndTheRestBuy() public {
        Plan memory p = defaultPlan();
        SpdexDcaVault a = createFunded(p);
        // The same code and terms, funded and due, but cloned by hand: nothing vouches for it.
        SpdexDcaVault byHand = handMadeFunded(SPX, SPX_WETH_PAIR, SPX_WETH_POOL, p);
        SpdexDcaVault b = createFunded(p);
        uint256 heldByHand = wethOf(address(byHand));

        vm.recordLogs();
        (uint256 bought,, bytes4[] memory reasons) = run(list3(address(a), address(byHand), address(b)), 0);
        VmLog[] memory logs = vm.getRecordedLogs();

        assertEq(bought, 2, "the factory's two bought");
        assertEq(reasons[1], SpdexVaultBatcher.NotFromFactory.selector, "the other is NotFromFactory");
        assertEq(byHand.buysDone(), 0, "it was not called");
        assertEq(wethOf(address(byHand)), heldByHand, "and nothing left it");
        VmLog[] memory skipped = logsOf(logs, address(batcher), NOT_TRIGGERED_TOPIC);
        assertEq(skipped.length, 1, "one NotTriggered");
        assertEq(address(uint160(uint256(skipped[0].topics[1]))), address(byHand), "for it");
        assertEq(skipped[0].topics[2], bytes32(SpdexVaultBatcher.NotFromFactory.selector), "NotFromFactory");
        assertEq(abi.decode(skipped[0].data, (uint256)), 0, "no gas spent on it");
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
        SpdexDcaVault byHand = handMadeFunded(SPX, SPX_WETH_PAIR, SPX_WETH_POOL, p);
        directBuy(a);
        directBuy(b);
        bytes4[] memory expected = new bytes4[](3);
        expected[0] = SpdexDcaVault.TooSoon.selector;
        expected[1] = SpdexDcaVault.TooSoon.selector;
        expected[2] = SpdexVaultBatcher.NotFromFactory.selector;
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SpdexVaultBatcher.NothingBought.selector, expected));
        batcher.executeBatch(list3(address(a), address(b), address(byHand)), rewardTo, 0);
    }

    function test_anEmptyListRevertsNothingBought() public {
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SpdexVaultBatcher.NothingBought.selector, new bytes4[](0)));
        batcher.executeBatch(new address[](0), rewardTo, 0);
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
        batcher.executeBatch(list2(address(due), address(taken)), rewardTo, both);
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

    function test_earnedExcludesStrayWeth() public {
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
        batcher.executeBatch(list2(address(a), address(b)), rewardTo, rewards + 1);

        vm.recordLogs();
        (, uint256 earned,) = run(list2(address(a), address(b)), rewards);
        VmLog[] memory batch = logsOf(vm.getRecordedLogs(), address(batcher), BATCH_TOPIC);
        assertEq(earned, rewards, "earned is the rewards alone");
        (,,, uint256 loggedEarned, uint256 swept) =
            abi.decode(batch[0].data, (uint256, uint256, uint256, uint256, uint256));
        assertEq(loggedEarned, rewards, "Batch.earned is the rewards alone");
        assertEq(swept, stray, "Batch.swept is what was here before");
        assertEq(wethOf(rewardTo), rewards + stray, "rewardTo received both");
        assertEq(wethOf(address(batcher)), 0, "and nothing is left");
    }

    function test_rewardToMustBeSomeoneElse() public {
        Plan memory p = defaultPlan();
        SpdexDcaVault a = createFunded(p);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SpdexVaultBatcher.BadRewardTo.selector, address(0)));
        batcher.executeBatch(list1(address(a)), address(0), 0);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SpdexVaultBatcher.BadRewardTo.selector, address(batcher)));
        batcher.executeBatch(list1(address(a)), address(batcher), 0);
        assertEq(a.buysDone(), 0, "nothing bought");
    }

    function test_tooManyVaultsIsRefused() public {
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SpdexVaultBatcher.TooManyVaults.selector, 151, 150));
        batcher.executeBatch(new address[](151), rewardTo, 0);
    }

    // ─── What a vault can do to a batch ──────────────────────────────────────────

    function test_aSuccessWithoutReturnDataIsNotBought() public {
        (MockVaultFactory mock, SpdexVaultBatcher bound) = mockFactory();
        SilentVault silent = new SilentVault();
        mock.vouch(address(silent));
        PayingVault payer = paying(mock, 1_000, 1);

        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                SpdexVaultBatcher.NothingBought.selector, reasonsOf(SpdexVaultBatcher.EmptyReturn.selector)
            )
        );
        bound.executeBatch(list1(address(silent)), rewardTo, 0);

        vm.recordLogs();
        vm.prank(keeper);
        (uint256 bought,, bytes4[] memory reasons) =
            bound.executeBatch(list2(address(silent), address(payer)), rewardTo, 0);
        VmLog[] memory skipped = logsOf(vm.getRecordedLogs(), address(bound), NOT_TRIGGERED_TOPIC);
        assertEq(bought, 1, "only the paying one counts");
        assertEq(reasons[0], SpdexVaultBatcher.EmptyReturn.selector, "EmptyReturn");
        assertEq(silent.calls(), 1, "it was called, and succeeded");
        assertEq(skipped.length, 1, "one NotTriggered");
        assertEq(skipped[0].topics[2], bytes32(SpdexVaultBatcher.EmptyReturn.selector), "EmptyReturn, indexed");
        assertGt(abi.decode(skipped[0].data, (uint256)), 0, "with the gas it cost");
    }

    function reasonsOf(bytes4 a) internal pure returns (bytes4[] memory r) {
        r = new bytes4[](1);
        r[0] = a;
    }

    /// Each vault is given exactly `EXECUTE_GAS_CAP`, the last one included, in a batch sent
    /// with just enough gas for the last to be attempted: `MIN_GAS_PER_ATTEMPT` is enough to
    /// beat the 63/64 rule.
    function test_eachAttemptGetsExactlyTheCap() public {
        // What a probe sees on entry when called with exactly the cap: the cap, less its own
        // dispatch before it reads the gas.
        GasProbe yardstick = new GasProbe();
        (bool called,) = address(yardstick).call{gas: CAP}(abi.encodeCall(GasProbe.execute, ()));
        assertTrue(called, "the yardstick probe ran");
        uint256 withTheCap = yardstick.seen();
        assertGt(withTheCap, CAP - 200, "a probe's own dispatch is a few dozen opcodes");

        (MockVaultFactory mock, SpdexVaultBatcher bound) = mockFactory();
        GasProbe[] memory probes = new GasProbe[](3);
        address[] memory vaults = new address[](3);
        for (uint256 i; i < 3; i++) {
            probes[i] = new GasProbe();
            mock.vouch(address(probes[i]));
            vaults[i] = address(probes[i]);
        }
        uint256 gas = leastGasToTry(bound, vaults, 2, rewardTo);
        console.log("least gas for three probes to be tried", gas);
        (bool ok, bytes4[] memory reasons,) = sendWithGasKept(bound, vaults, rewardTo, gas);
        assertTrue(ok, "the batch went through");
        for (uint256 i; i < 3; i++) {
            assertEq(reasons[i], bytes4(0), "each probe answered like a buy");
            assertEq(probes[i].seen(), withTheCap, "every attempt had exactly the cap");
        }
    }

    /// The worst end for a batch: its last attempt burns the whole cap with only
    /// `MIN_GAS_PER_ATTEMPT` left before it, and the reward then goes to a `rewardTo` that has
    /// never held WETH. It still finishes.
    function test_theBatchFinishesWhenTheLastAttemptBurnsTheCap() public {
        (MockVaultFactory mock, SpdexVaultBatcher bound) = mockFactory();
        PayingVault payer = paying(mock, 1_000, 1);
        GasBurner burner = new GasBurner();
        mock.vouch(address(burner));
        address freshRewardTo = fresh("fresh-reward-to");
        address[] memory vaults = list2(address(payer), address(burner));

        uint256 gas = leastGasToTry(bound, vaults, 1, freshRewardTo);
        vm.recordLogs();
        (bool ok, bytes4[] memory reasons,) = sendWithGasKept(bound, vaults, freshRewardTo, gas);
        assertTrue(ok, "it finished");
        assertEq(reasons[1], SpdexVaultBatcher.EmptyRevert.selector, "the burner was tried, and burned");
        assertEq(logsOf(vm.getRecordedLogs(), address(bound), BATCH_TOPIC).length, 1, "and said so in Batch");
        assertEq(wethOf(freshRewardTo), 1_000, "the reward reached the fresh rewardTo");
    }

    /// The same end for the longest list: 150 vaults that each burn the cap, the last with
    /// only `MIN_GAS_PER_ATTEMPT` left before it, still revert `NothingBought` with every
    /// reason rather than run out of gas encoding them.
    ///
    /// Searching for that gas with 150 burners would burn 60 million gas a try, more than a
    /// test may. So the search runs on a list whose first 149 refuse at once instead: every
    /// attempt costs the batcher the same but for what the vault itself spends, so the
    /// burners' list needs exactly 149 × (the cap − a bare refusal's own gas) more. The two
    /// sends on the real list — at that gas, and one less — show the figure is exact.
    function test_theLongestListStillRevertsWithEveryReasonWhenTheLastBurnsTheCap() public {
        (MockVaultFactory mock, SpdexVaultBatcher bound) = mockFactory();
        uint256 n = bound.MAX_VAULTS();
        address[] memory burners = new address[](n);
        address[] memory cheap = new address[](n);
        for (uint256 i; i < n; i++) {
            burners[i] = address(new GasBurner());
            mock.vouch(burners[i]);
            if (i + 1 < n) {
                cheap[i] = address(new BareRevert());
                mock.vouch(cheap[i]);
            }
        }
        cheap[n - 1] = burners[n - 1];

        (bool refused,) = cheap[0].call{gas: CAP}("");
        assertTrue(!refused, "a bare refusal refuses");
        uint256 bareOwnGas = vmb.lastCallGas().gasTotalUsed;
        uint256 gas = leastGasToTry(bound, cheap, n - 1, rewardTo) + (n - 1) * (CAP - bareOwnGas);
        console.log("least gas for 150 burners to be tried", gas);

        (bool readable, bool ok, bytes4[] memory reasons) = sendWithGas(bound, burners, rewardTo, gas);
        assertTrue(readable && !ok, "NothingBought, with its reasons, not an out-of-gas");
        for (uint256 i; i < n; i++) {
            assertEq(reasons[i], SpdexVaultBatcher.EmptyRevert.selector, "every burner tried");
        }
        (readable, ok, reasons) = sendWithGas(bound, burners, rewardTo, gas - 1);
        assertTrue(readable && reasons[n - 1] == SpdexVaultBatcher.NotTried.selector, "one gas less, the last is not");
    }

    function test_whenGasRunsShortTheRestAreNotTriedNotFailed() public {
        (MockVaultFactory mock, SpdexVaultBatcher bound) = mockFactory();
        PayingVault payer = paying(mock, 1_000, 1);
        GasProbe second = new GasProbe();
        GasProbe third = new GasProbe();
        mock.vouch(address(second));
        mock.vouch(address(third));
        address[] memory vaults = list3(address(payer), address(second), address(third));

        uint256 gas = leastGasToTry(bound, vaults, 1, rewardTo) - 1;
        vm.recordLogs();
        (bool ok, bytes4[] memory reasons,) = sendWithGasKept(bound, vaults, rewardTo, gas);
        VmLog[] memory logs = vm.getRecordedLogs();
        assertTrue(ok, "the batch went through");
        assertEq(reasons[0], bytes4(0), "the first bought");
        assertEq(reasons[1], SpdexVaultBatcher.NotTried.selector, "the second was not tried");
        assertEq(reasons[2], SpdexVaultBatcher.NotTried.selector, "nor the third");
        assertEq(second.seen() + third.seen(), 0, "neither was called");
        assertEq(logsOf(logs, address(bound), NOT_TRIGGERED_TOPIC).length, 0, "and no event says they failed");
        VmLog[] memory batch = logsOf(logs, address(bound), BATCH_TOPIC);
        (uint256 listed, uint256 tried, uint256 bought,,) =
            abi.decode(batch[0].data, (uint256, uint256, uint256, uint256, uint256));
        assertEq(listed, 3, "three listed");
        assertEq(tried, 1, "one tried");
        assertEq(bought, 1, "one bought");
    }

    function test_aVaultThatBurnsItsGasCostsAtMostTheCap() public {
        (MockVaultFactory mock, SpdexVaultBatcher bound) = mockFactory();
        PayingVault payer = paying(mock, 1_000, 1);
        GasBurner burner = new GasBurner();
        mock.vouch(address(burner));
        vm.recordLogs();
        vm.prank(keeper);
        bound.executeBatch(list2(address(payer), address(burner)), rewardTo, 0);
        VmLog[] memory skipped = logsOf(vm.getRecordedLogs(), address(bound), NOT_TRIGGERED_TOPIC);
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
        (MockVaultFactory mock, SpdexVaultBatcher bound) = mockFactory();
        PayingVault payer = paying(mock, 1_000, 2);
        ReturnBomb bomb = new ReturnBomb(256 * 1024);
        ReturnBomb small = new ReturnBomb(4);
        mock.vouch(address(bomb));
        mock.vouch(address(small));

        (uint256 bombAttempt, bytes4 bombReason) = attemptGas(bound, address(payer), address(bomb));
        (uint256 smallAttempt, bytes4 smallReason) = attemptGas(bound, address(payer), address(small));
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
    function attemptGas(SpdexVaultBatcher bound, address payer, address vault)
        internal
        returns (uint256 used, bytes4 reason)
    {
        uint256 snapshot = vmb.snapshotState();
        vmb.cool(vault);
        vm.recordLogs();
        vm.prank(keeper);
        bound.executeBatch(list2(payer, vault), rewardTo, 0);
        VmLog[] memory skipped = logsOf(vm.getRecordedLogs(), address(bound), NOT_TRIGGERED_TOPIC);
        assertEq(skipped.length, 1, "one NotTriggered");
        used = abi.decode(skipped[0].data, (uint256));
        reason = bytes4(skipped[0].topics[2]);
        vmb.revertToState(snapshot);
    }

    /// The gas a call to `vault.execute()` spends inside `vault`, from its side.
    function ownGas(address vault) internal returns (uint256) {
        (bool ok,) = vault.call{gas: CAP}(abi.encodeCall(ReturnBomb.execute, ()));
        assertTrue(!ok, "it refuses");
        return vmb.lastCallGas().gasTotalUsed;
    }

    function test_reenteringTheBatcherIsRefusedAndStealsNothing() public {
        (MockVaultFactory mock, SpdexVaultBatcher bound) = mockFactory();
        PayingVault payer = paying(mock, 1_000, 2);
        ReenteringVault thief = new ReenteringVault(WETH);
        giveWeth(address(thief), 1);
        mock.vouch(address(thief));
        address attacker = fresh("attacker");
        thief.aim(IBatcherMock(address(bound)), list1(address(payer)), attacker);

        vm.prank(keeper);
        (uint256 bought, uint256 earned,) = bound.executeBatch(list2(address(payer), address(thief)), rewardTo, 0);
        assertEq(thief.innerRevert(), abi.encodeWithSelector(SpdexVaultBatcher.Reentrancy.selector), "Reentrancy");
        assertEq(bought, 2, "the outer batch went on");
        assertEq(earned, 1_001, "and earned both rewards");
        assertEq(wethOf(attacker), 0, "the nested batch took nothing");
        assertEq(wethOf(rewardTo), 1_001, "the outer rewardTo got everything");
    }

    function test_etherSentToTheBatcherIsRefused() public {
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        (bool ok,) = address(batcher).call{value: 1}("");
        assertTrue(!ok, "a plain transfer reverts");
        vm.prank(stranger);
        (ok,) = address(batcher).call{value: 1}(
            abi.encodeCall(SpdexVaultBatcher.executeBatch, (new address[](0), rewardTo, 0))
        );
        assertTrue(!ok, "and so does ether with a batch");
        assertEq(address(batcher).balance, 0, "it holds none");
    }

    function test_eventsCarryTheirFigures() public {
        Plan memory p = defaultPlan();
        SpdexDcaVault due = createFunded(p);
        SpdexDcaVault early = createFunded(p);
        SpdexDcaVault byHand = handMadeFunded(SPX, SPX_WETH_PAIR, SPX_WETH_POOL, p);
        directBuy(early);

        vm.recordLogs();
        run(list3(address(due), address(early), address(byHand)), 0);
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
        (, uint256 amountOut, uint256 reward,,,) =
            abi.decode(logs[boughtAt].data, (uint256, uint256, uint256, uint256, uint256, uint256));
        (uint256 received, uint256 gasUsed) = abi.decode(triggered.data, (uint256, uint256));
        assertEq(received, amountOut, "received is Bought.amountOut");
        assertGt(gasUsed, 0, "with its gas");
        assertLt(gasUsed, CAP + 3_001, "within the cap");

        VmLog[] memory refused = logsOf(logs, address(batcher), NOT_TRIGGERED_TOPIC);
        assertEq(refused.length, 2, "two NotTriggered, in order");
        assertEq(address(uint160(uint256(refused[0].topics[1]))), address(early), "the early one");
        assertEq(refused[0].topics[2], bytes32(SpdexDcaVault.TooSoon.selector), "TooSoon, indexed");
        assertGt(abi.decode(refused[0].data, (uint256)), 0, "it cost gas");
        assertEq(address(uint160(uint256(refused[1].topics[1]))), address(byHand), "the hand-made one");
        assertEq(refused[1].topics[2], bytes32(SpdexVaultBatcher.NotFromFactory.selector), "NotFromFactory");
        assertEq(abi.decode(refused[1].data, (uint256)), 0, "it cost nothing");

        VmLog[] memory batch = logsOf(logs, address(batcher), BATCH_TOPIC);
        assertEq(batch.length, 1, "one Batch");
        assertEq(
            batch[0].data,
            abi.encode(uint256(3), uint256(3), uint256(1), reward, uint256(0)),
            "3 listed, 3 tried, 1 bought"
        );
        assertEq(logs[logs.length - 1].topics[0], BATCH_TOPIC, "Batch is the last log");
    }

    // ─── Where it lives ──────────────────────────────────────────────────────────

    /// Deployed like the factory, through the deterministic deployer after it, the batcher's
    /// address depends only on its code and the factory's address.
    function test_deployedThroughTheDeterministicDeployerLandsWhereExpected() public {
        bytes memory factoryInit = abi.encodePacked(
            type(SpdexVaultFactory).creationCode, abi.encode(WETH, V2_FACTORY, V3_FACTORY, spxMarkets())
        );
        address mainnetFactory = create2(FACTORY_SALT, factoryInit);
        bytes memory batcherInit = abi.encodePacked(type(SpdexVaultBatcher).creationCode, abi.encode(mainnetFactory));
        address expected = create2(BATCHER_SALT, batcherInit);

        // Before its factory exists, it cannot be deployed: its constructor reads the factory.
        (bool ok,) = DETERMINISTIC_DEPLOYER.call{gas: 5_000_000}(abi.encodePacked(BATCHER_SALT, batcherInit));
        assertTrue(!ok, "not before the factory");

        (ok,) = DETERMINISTIC_DEPLOYER.call(abi.encodePacked(FACTORY_SALT, factoryInit));
        assertTrue(ok, "the factory deployed");
        bytes memory returned;
        (ok, returned) = DETERMINISTIC_DEPLOYER.call(abi.encodePacked(BATCHER_SALT, batcherInit));
        assertTrue(ok, "then the batcher");
        assertEq(address(bytes20(returned)), expected, "where CREATE2 says");
        SpdexVaultBatcher deployed = SpdexVaultBatcher(expected);
        assertEq(deployed.factory(), mainnetFactory, "bound to that factory");
        assertEq(address(deployed.weth()), WETH, "paying in its WETH");
        console.log("SpdexVaultFactory for mainnet WETH and SPX's market", mainnetFactory);
        console.log("its SpdexVaultBatcher", expected);

        (ok,) = DETERMINISTIC_DEPLOYER.call{gas: 5_000_000}(abi.encodePacked(BATCHER_SALT, batcherInit));
        assertTrue(!ok, "a second deployment to the same address fails");
        bytes memory otherInit = abi.encodePacked(type(SpdexVaultBatcher).creationCode, abi.encode(address(factory)));
        assertTrue(create2(BATCHER_SALT, otherInit) != expected, "another factory, another batcher");
    }

    function create2(bytes32 salt, bytes memory initCode) internal pure returns (address) {
        return address(
            uint160(
                uint256(keccak256(abi.encodePacked(bytes1(0xff), DETERMINISTIC_DEPLOYER, salt, keccak256(initCode))))
            )
        );
    }

    function test_constructorRefusesAFactoryWithNoCode() public {
        vm.expectRevert(abi.encodeWithSelector(SpdexVaultBatcher.NoFactory.selector, stranger));
        new SpdexVaultBatcher(stranger);
    }
}
