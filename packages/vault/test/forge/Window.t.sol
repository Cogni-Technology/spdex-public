// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.33;

import {ForkTest, IV2PairTest, Plan} from "./utils/Fork.sol";
import {VmLog, console} from "./utils/Test.sol";
import {MockRegistry} from "./utils/Mocks.sol";
import {SpdexDcaVault} from "../../contracts/SpdexDcaVault.sol";
import {SpdexVaultFactory} from "../../contracts/SpdexVaultFactory.sol";

/// What one buy did, as far as anyone can see: what the owner got, who was paid what, its
/// `Bought` log, and the vault's state afterwards.
struct Outcome {
    uint256 received;
    uint256 reward;
    uint256 ownerSpxDelta;
    uint256 paidWethDelta;
    bytes32 slotTopic;
    bytes32 keeperTopic;
    address rewardTo;
    bytes boughtData;
    uint256 vaultWeth;
    uint256 buysDone;
    uint256 lastBuyAt;
    uint256 totalOut;
    uint256 windowBuys;
    uint256 pairReserveWeth;
    uint256 pairReserveSpx;
}

/// The community window (`docs/V2_UPGRADE.md`, decisions 3, 4 and 10 to 14): when a buy falls
/// due, for how long only its owner or an address the registry finds eligible may be paid for
/// it, and that whom it pays is the only thing about a buy its caller chooses. Every edge to
/// the second, with `vm.warp`, which moves only this test's EVM.
///
/// `holder` and `holder2` are eligible; `outsider`, `stranger` and `owner` are not (the owner
/// needs no eligibility). The caller is usually someone other than the address paid, because
/// the vault checks who is paid, never who sends.
contract WindowTest is ForkTest {
    address internal holder;
    address internal holder2;
    address internal outsider;

    function setUp() public override {
        super.setUp();
        holder = fresh("holder");
        holder2 = fresh("holder-2");
        outsider = fresh("outsider");
        makeEligible(holder);
        makeEligible(holder2);
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────────

    function notEligible(address rewardTo, uint256 windowEndsAt) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(SpdexDcaVault.NotEligible.selector, rewardTo, windowEndsAt);
    }

    function windowOf(SpdexDcaVault vault) internal view returns (uint256 dueSince, uint256 windowEndsAt) {
        (,,,,, dueSince, windowEndsAt,,) = vault.status();
    }

    function nextBuyAtOf(SpdexDcaVault vault) internal view returns (uint256 nextBuyAt) {
        (, nextBuyAt,,,,,,,) = vault.status();
    }

    /// `caller` sends `execute(rewardTo)`, which must be refused with exactly `reason`.
    function expectRefusal(SpdexDcaVault vault, address caller, address rewardTo, bytes memory reason) internal {
        vm.prank(caller);
        vm.expectRevert(reason);
        vault.execute(rewardTo);
    }

    /// `caller` sends `execute(rewardTo)`, which must buy; returns its one `Bought` log.
    function buyAs(SpdexDcaVault vault, address caller, address rewardTo) internal returns (VmLog memory log) {
        vm.recordLogs();
        vm.prank(caller);
        vault.execute(rewardTo);
        log = boughtIn(vm.getRecordedLogs(), address(vault));
    }

    function boughtIn(VmLog[] memory logs, address vault) internal pure returns (VmLog memory found) {
        uint256 n;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == vault && logs[i].topics[0] == BOUGHT_TOPIC) {
                found = logs[i];
                n++;
            }
        }
        assertEq(n, 1, "one Bought");
    }

    function dueSinceIn(VmLog memory log) internal pure returns (uint256 dueSince) {
        (,,,,,, dueSince) = abi.decode(log.data, (uint256, uint256, uint256, uint256, uint256, uint256, uint256));
    }

    function rewardToIn(VmLog memory log) internal pure returns (address) {
        return address(uint160(uint256(log.topics[3])));
    }

    // ─── When a buy falls due ────────────────────────────────────────────────────

    /// A plan's first buy falls due at `startAt`: its window runs from there, an ineligible
    /// address is refused until its last second, and anyone may be paid from its end.
    function test_aFirstBuyIsDueFromStartAt() public {
        Plan memory p = defaultPlan();
        p.startAt = block.timestamp + 1 hours;
        SpdexDcaVault vault = createFunded(p);
        uint256 ends = p.startAt + p.communityWindow;
        (uint256 dueSince, uint256 windowEndsAt) = windowOf(vault);
        assertEq(dueSince, p.startAt, "due from startAt");
        assertEq(windowEndsAt, ends, "its window, 15 minutes on");

        vm.warp(p.startAt);
        expectRefusal(vault, outsider, outsider, notEligible(outsider, ends));
        vm.warp(ends - 1);
        expectRefusal(vault, outsider, outsider, notEligible(outsider, ends));
        vm.warp(ends);
        VmLog memory log = buyAs(vault, outsider, outsider);
        assertEq(dueSinceIn(log), p.startAt, "Bought says when it fell due");
        assertEq(wethOf(outsider), p.keeperReward, "and the outsider was paid, after the window");
        assertEq(vault.windowBuys(), 0, "not a window buy");
    }

    /// v1's `nextBuyAt` is the start of the slot after the last buy's, which is in the past
    /// once a slot has been missed. The window is measured from the start of the slot the buy
    /// is made in instead, so the first buy after a miss has a window too (decision 10).
    function test_afterAMissedSlotTheWindowStartsAtTheSlotsStart() public {
        Plan memory p = defaultPlan();
        SpdexDcaVault vault = createFunded(p);
        buyAs(vault, owner, owner); // slot 0

        // Slot 1 passes with nobody buying.
        uint256 slot2 = p.startAt + 2 * p.interval;
        vm.warp(slot2 + 600);
        assertEq(nextBuyAtOf(vault), p.startAt + p.interval, "the clock has allowed it since slot 1");
        (uint256 dueSince, uint256 windowEndsAt) = windowOf(vault);
        assertEq(dueSince, slot2, "but it is due from slot 2's start");
        assertEq(windowEndsAt, slot2 + p.communityWindow, "and its window runs from there");
        expectRefusal(vault, outsider, outsider, notEligible(outsider, windowEndsAt));
        vm.warp(windowEndsAt - 1);
        expectRefusal(vault, outsider, outsider, notEligible(outsider, windowEndsAt));
        vm.warp(windowEndsAt);
        assertEq(dueSinceIn(buyAs(vault, outsider, outsider)), slot2, "Bought says slot 2's start");

        // The same for a plan whose first slots went unbought: due from the current slot.
        p = defaultPlan();
        p.startAt = block.timestamp - 2 * p.interval - 100;
        vault = createFunded(p);
        (dueSince, windowEndsAt) = windowOf(vault);
        assertEq(nextBuyAtOf(vault), p.startAt, "allowed since its start");
        assertEq(dueSince, p.startAt + 2 * p.interval, "due from the current slot's start");
        expectRefusal(vault, outsider, outsider, notEligible(outsider, windowEndsAt));
        VmLog memory log = buyAs(vault, stranger, holder);
        assertEq(dueSinceIn(log), dueSince, "and Bought agrees");
    }

    /// A buy made in the last second of a slot holds the next one back half an interval: the
    /// next buy falls due then, and its window runs from then — still inside its slot.
    function test_afterTheSpacingRuleTheWindowStartsHalfAnIntervalAfterTheLastBuy() public {
        Plan memory p = defaultPlan();
        SpdexDcaVault vault = createFunded(p);
        vm.warp(p.startAt + p.interval - 1);
        buyAs(vault, owner, owner); // the last second of slot 0
        uint256 spaced = p.startAt + p.interval - 1 + p.interval / 2;

        vm.warp(p.startAt + p.interval);
        (uint256 dueSince, uint256 windowEndsAt) = windowOf(vault);
        assertEq(dueSince, spaced, "slot 1 has begun, but the buy falls due half an interval after the last");
        assertEq(windowEndsAt, spaced + p.communityWindow, "its window from then");
        assertLt(windowEndsAt, p.startAt + 2 * p.interval, "ending inside slot 1");
        expectRefusal(vault, outsider, outsider, abi.encodeWithSelector(SpdexDcaVault.TooSoon.selector, spaced));

        vm.warp(spaced);
        expectRefusal(vault, outsider, outsider, notEligible(outsider, windowEndsAt));
        vm.warp(windowEndsAt - 1);
        expectRefusal(vault, outsider, outsider, notEligible(outsider, windowEndsAt));
        vm.warp(windowEndsAt);
        assertEq(dueSinceIn(buyAs(vault, outsider, outsider)), spaced, "Bought says when it fell due");
    }

    /// A plan's first buy falls due at `startAt`, whenever the vault was made. A "first buy
    /// now" plan built with the head's time as `startAt` and included 80 seconds later, on a
    /// 5-minute plan whose window is 75 seconds, is created with its first window already
    /// over: its first buy is open to anyone from the block it appears in. The vault cannot
    /// know when it was created without making its address depend on the block, so giving a
    /// new plan a first window is the app's: a `startAt` far enough ahead for the signature
    /// and the inclusion, as the second plan here has, opens the window after the vault
    /// exists.
    function test_aFirstBuyWhoseWindowEndedBeforeTheVaultExistedIsOpenAtOnce() public {
        Plan memory p = defaultPlan();
        p.interval = 300;
        p.communityWindow = 75;
        p.startAt = block.timestamp; // built at the head's time
        vm.warp(block.timestamp + 80); // signed and included 80 seconds later
        SpdexDcaVault vault = createFunded(p);
        (uint256 dueSince, uint256 windowEndsAt) = windowOf(vault);
        assertEq(dueSince, p.startAt, "due from startAt, before the vault existed");
        assertLt(windowEndsAt, block.timestamp, "its first window ended before it was created");
        buyAs(vault, outsider, outsider);
        assertEq(wethOf(outsider), p.keeperReward, "an outsider is paid for the first buy at once");
        assertEq(vault.windowBuys(), 0, "no first claim for the community");

        Plan memory ahead = defaultPlan();
        ahead.interval = 300;
        ahead.communityWindow = 75;
        ahead.startAt = block.timestamp + 120; // the head's time and room to sign
        vm.warp(block.timestamp + 80);
        vault = createFunded(ahead);
        (dueSince, windowEndsAt) = windowOf(vault);
        assertGt(dueSince, block.timestamp, "due after it exists");
        vm.warp(dueSince);
        expectRefusal(vault, outsider, outsider, notEligible(outsider, windowEndsAt));
        buyAs(vault, stranger, holder);
        assertEq(vault.windowBuys(), 1, "and its first buy is the community's first");
    }

    /// Each slot has one window, from when its buy fell due. A buy the vault could not make
    /// during it — short of WETH until a top-up, a floor that refused throughout — is open
    /// to anyone from the moment it becomes possible: here, in the same block as the owner's
    /// top-up. An owner who tops up an overdue vault can make the buy at once with Trigger
    /// now (`execute(owner)`), which the window never refuses.
    function test_aBuyThatBecomesPossibleOnlyAfterItsWindowIsOpenAtOnce() public {
        Plan memory p = defaultPlan();
        SpdexDcaVault vault = create(p); // unfunded
        vm.warp(p.startAt + p.communityWindow);
        vm.prank(owner);
        vault.fund{value: budgetOf(p)}();
        (uint256 dueSince, uint256 windowEndsAt) = windowOf(vault);
        assertEq(dueSince, p.startAt, "it fell due at startAt, unfunded");
        assertEq(windowEndsAt, block.timestamp, "and its window ended as it was funded");
        buyAs(vault, outsider, outsider);
        assertEq(wethOf(outsider), p.keeperReward, "an outsider is paid in the block of the top-up");
    }

    // ─── Who may be paid ─────────────────────────────────────────────────────────

    /// The owner may always be paid, so Trigger now works inside the window, whoever sends it.
    /// A buy paid back to its owner pays nobody else and is not a window buy.
    function test_theOwnerMayBePaidInsideTheWindow() public {
        Plan memory p = defaultPlan();
        SpdexDcaVault vault = createFunded(p);

        VmLog memory log = buyAs(vault, stranger, owner);
        assertEq(address(uint160(uint256(log.topics[2]))), stranger, "sent by a stranger");
        assertEq(rewardToIn(log), owner, "paid to the owner");
        assertEq(wethOf(owner), p.keeperReward, "the fee came back to the owner");
        assertEq(wethOf(stranger), 0, "and the stranger got nothing");

        vm.warp(p.startAt + p.interval);
        buyAs(vault, owner, owner); // Trigger now, at the first second of slot 1's window
        assertEq(vault.buysDone(), 2, "two buys inside their windows");
        assertEq(vault.windowBuys(), 0, "neither of them a window buy");
    }

    /// `windowBuys` counts exactly the buys made inside their window and paid to someone other
    /// than the owner: an eligible address inside the window counts; the same address after
    /// it, an outsider after it, and the owner inside it do not.
    function test_windowBuysCountsOnlyCommunityBuysInsideTheirWindow() public {
        Plan memory p = defaultPlan();
        SpdexDcaVault vault = createFunded(p);

        buyAs(vault, stranger, holder); // slot 0, inside
        assertEq(vault.windowBuys(), 1, "an eligible address inside the window: counted");

        vm.warp(p.startAt + p.interval + p.communityWindow);
        buyAs(vault, stranger, holder); // slot 1, the window's end
        assertEq(vault.windowBuys(), 1, "the same address after the window: not counted");

        vm.warp(p.startAt + 2 * p.interval + p.communityWindow - 1);
        buyAs(vault, stranger, holder2); // slot 2, the window's last second
        assertEq(vault.windowBuys(), 2, "another eligible address, at the window's last second: counted");

        vm.warp(p.startAt + 3 * p.interval + p.communityWindow);
        buyAs(vault, outsider, outsider); // slot 3, after
        vm.warp(p.startAt + 4 * p.interval);
        buyAs(vault, keeper, owner); // slot 4, inside, the owner
        assertEq(vault.windowBuys(), 2, "an outsider after the window, the owner inside it: neither");
        assertEq(vault.buysDone(), 5, "five buys in all");
        assertEq(wethOf(holder), 2 * p.keeperReward, "holder paid twice");
        assertEq(wethOf(holder2), p.keeperReward, "holder2 once");
    }

    /// Eligibility is the address paid, never the caller's: an outsider that names a holder
    /// it does not control can make the buy, and pays that holder, not itself. So naming an
    /// eligible address gains a caller nothing.
    function test_aCallerNamingAnEligibleAddressItDoesNotControlPaysThatAddress() public {
        Plan memory p = defaultPlan();
        SpdexDcaVault vault = createFunded(p);
        VmLog memory log = buyAs(vault, outsider, holder);
        assertEq(address(uint160(uint256(log.topics[2]))), outsider, "the outsider sent it");
        assertEq(rewardToIn(log), holder, "and named the holder");
        assertEq(wethOf(holder), p.keeperReward, "the holder was paid");
        assertEq(wethOf(outsider), 0, "the outsider was not");
        assertEq(vault.windowBuys(), 1, "a community buy");
    }

    /// Zero, and the vault itself, may never be paid: inside the window or after it.
    function test_rewardToMayNeverBeZeroOrTheVault() public {
        Plan memory p = defaultPlan();
        SpdexDcaVault vault = createFunded(p);
        for (uint256 k; k < 2; k++) {
            if (k == 1) vm.warp(p.startAt + p.communityWindow);
            expectRefusal(
                vault, keeper, address(0), abi.encodeWithSelector(SpdexDcaVault.BadRewardTo.selector, address(0))
            );
            expectRefusal(
                vault,
                keeper,
                address(vault),
                abi.encodeWithSelector(SpdexDcaVault.BadRewardTo.selector, address(vault))
            );
        }
        assertEq(vault.buysDone(), 0, "nothing bought");
        buyAs(vault, keeper, outsider);
        assertEq(vault.buysDone(), 1, "while any other address may be paid after the window");
    }

    // ─── The factory's bounds ────────────────────────────────────────────────────

    function createWith(uint256 interval, uint256 window, bool accepted) internal {
        Plan memory p = defaultPlan();
        p.interval = interval;
        p.communityWindow = window;
        if (!accepted) {
            uint256 longest = interval / 4 < 3_600 ? interval / 4 : 3_600;
            vm.prank(owner);
            vm.expectRevert(
                abi.encodeWithSelector(SpdexVaultFactory.CommunityWindowOutOfRange.selector, window, 60, longest)
            );
            factory.createVault(
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
            return;
        }
        assertEq(create(p).terms().communityWindow, window, "accepted, and held as given");
    }

    /// A window is at least a minute, at most an hour, and at most a quarter of the interval,
    /// rounded down: to the second, at every bound, and each refusal names the window and both
    /// bounds.
    function test_theFactoryHoldsTheWindowToItsBoundsToTheSecond() public {
        assertEq(factory.MIN_COMMUNITY_WINDOW(), 60, "a minute");
        assertEq(factory.MAX_COMMUNITY_WINDOW(), 3_600, "an hour");

        // The minute.
        createWith(1 hours, 0, false);
        createWith(1 hours, 59, false);
        createWith(1 hours, 60, true);
        // The hour, where a quarter of the interval allows more.
        createWith(4 hours, 3_600, true);
        createWith(4 hours, 3_601, false);
        createWith(366 days, 3_600, true);
        createWith(366 days, 3_601, false);
        // A quarter of the interval, where it is less than an hour.
        createWith(1 hours, 900, true);
        createWith(1 hours, 901, false);
        createWith(300, 75, true); // the shortest interval still allows 75 seconds
        createWith(300, 76, false);
        // Odd intervals: a quarter rounds down.
        createWith(301, 75, true);
        createWith(301, 76, false);
        createWith(303, 75, true);
        createWith(303, 76, false);
        createWith(304, 76, true);
        createWith(304, 77, false);
    }

    // ─── A registry that fails ───────────────────────────────────────────────────

    /// A registry that reverts, burns its whole stipend, answers nothing, answers a word short
    /// of `true` or answers 2 counts as "not eligible" (decision 14), and costs the buy at most
    /// its stipend: the caller keeps the rest of its gas. The owner is never asked about, so
    /// Trigger now works while it fails, and after the window anyone may be paid without the
    /// registry being asked at all.
    function test_aRegistryThatFailsCountsAsNotEligible() public {
        MockRegistry broken = new MockRegistry(SPX);
        SpdexVaultFactory f = deployFactoryWith(address(broken), spxMarkets());
        Plan memory p = defaultPlan();
        SpdexDcaVault vault = createFundedOn(f, p);
        uint256 ends = p.startAt + p.communityWindow;

        // The plain "no", for comparison. Set rather than left as the default, so that its
        // registry slot is as warm as those the answers below are written to.
        broken.setEligible(outsider, false);
        uint256 noGas = refusedGas(vault, outsider, ends);
        uint256 stipend = vault.ELIGIBILITY_GAS();
        assertEq(stipend, 100_000, "the stipend");

        address[5] memory who = [
            fresh("reverts"), fresh("burns-gas"), fresh("answers-nothing"), fresh("answers-short"), fresh("answers-2")
        ];
        MockRegistry.Answer[5] memory answers = [
            MockRegistry.Answer.Revert,
            MockRegistry.Answer.BurnGas,
            MockRegistry.Answer.Empty,
            MockRegistry.Answer.Short,
            MockRegistry.Answer.Two
        ];
        for (uint256 i; i < 5; i++) {
            broken.setAnswer(who[i], answers[i]);
            uint256 used = refusedGas(vault, who[i], ends);
            console.log("a refused buy's gas, failing registry", used);
            assertLt(used, noGas + stipend + 1, "at most the stipend more than a plain no");
            assertLt(used, 150_000, "and the caller kept the rest of the million it sent");
            if (answers[i] == MockRegistry.Answer.BurnGas) {
                assertGt(used, noGas + stipend - 3_000, "the burner took its whole stipend");
            } else {
                assertLt(used, noGas + 500, "the others cost what a plain no does");
            }
        }
        console.log("a refused buy's gas, plain no", noGas);

        // The same registry saying yes is believed, so the vault is reading it.
        broken.setEligible(holder, true);
        uint256 snapshot = vm.snapshotState();
        buyAs(vault, stranger, holder);
        assertEq(vault.windowBuys(), 1, "a yes is a yes");
        vm.revertToState(snapshot);

        // The owner is never asked about, even when asking would fail.
        broken.setAnswer(owner, MockRegistry.Answer.BurnGas);
        snapshot = vm.snapshotState();
        buyAs(vault, stranger, owner);
        vm.revertToState(snapshot);

        // After the window the registry is not asked: an address it would fail on is paid.
        vm.warp(ends);
        buyAs(vault, stranger, who[1]);
        assertEq(wethOf(who[1]), p.keeperReward, "paid, after the window");
    }

    /// The gas a call of `execute(rewardTo)` with a million gas uses, which must be refused
    /// as not eligible for a window ending at `ends`; the state is put back.
    function refusedGas(SpdexDcaVault vault, address rewardTo, uint256 ends) internal returns (uint256 used) {
        uint256 snapshot = vm.snapshotState();
        vm.prank(stranger);
        uint256 g = gasleft();
        (bool ok, bytes memory reason) =
            address(vault).call{gas: 1_000_000}(abi.encodeCall(SpdexDcaVault.execute, (rewardTo)));
        used = g - gasleft();
        assertTrue(!ok, "refused");
        assertEq(reason, notEligible(rewardTo, ends), "as not eligible");
        vm.revertToState(snapshot);
    }

    // ─── status() and execute() agree ────────────────────────────────────────────

    /// At each edge — a second before the buy is allowed, the moment it falls due, the last
    /// second of its window and the window's end — `status()` says what `execute` then does:
    /// too soon, then only the owner or an eligible address, then anyone; and `Bought` carries
    /// the `dueSince` that `status()` gave. For a first buy, a buy after a missed slot, and a
    /// buy held back by the spacing rule.
    function test_statusAgreesWithExecuteAtEveryEdge() public {
        Plan memory p = defaultPlan();
        p.startAt = block.timestamp + 100;
        SpdexDcaVault vault = createFunded(p);
        checkEdges(vault, p.startAt);

        // After a missed slot: slot 0 bought, slot 1 missed, slot 2 due from its start.
        vm.warp(p.startAt);
        buyAs(vault, owner, owner);
        vm.warp(p.startAt + 2 * p.interval + 1);
        checkEdges(vault, p.startAt + 2 * p.interval);

        // Spacing: bought at slot 2's last second, the next falls due half an interval on.
        vm.warp(p.startAt + 3 * p.interval - 1);
        buyAs(vault, owner, owner);
        checkEdges(vault, p.startAt + 3 * p.interval - 1 + p.interval / 2);
    }

    /// Checks every edge of the window of the buy that falls due at `due`, from a copy of
    /// this moment each time.
    function checkEdges(SpdexDcaVault vault, uint256 due) internal {
        uint256 window = vault.terms().communityWindow;
        uint256[4] memory at = [due - 1, due, due + window - 1, due + window];
        for (uint256 k; k < 4; k++) {
            uint256 snapshot = vm.snapshotState();
            if (at[k] > block.timestamp) vm.warp(at[k]);
            (bool isDue, uint256 nextBuyAt,,,, uint256 dueSince, uint256 windowEndsAt,,) = vault.status();
            assertEq(dueSince, due, "status() gives when it falls due");
            assertEq(windowEndsAt, due + window, "and when its window ends");
            if (block.timestamp < nextBuyAt) {
                assertTrue(!isDue, "not due yet");
                vm.prank(outsider);
                vm.expectPartialRevert(
                    nextBuyAt == vault.terms().startAt && vault.buysDone() == 0
                        ? SpdexDcaVault.NotStarted.selector
                        : SpdexDcaVault.TooSoon.selector
                );
                vault.execute(outsider);
                vm.prank(stranger);
                vm.expectPartialRevert(
                    nextBuyAt == vault.terms().startAt && vault.buysDone() == 0
                        ? SpdexDcaVault.NotStarted.selector
                        : SpdexDcaVault.TooSoon.selector
                );
                vault.execute(holder);
            } else if (block.timestamp < windowEndsAt) {
                assertTrue(isDue, "due");
                expectRefusal(vault, outsider, outsider, notEligible(outsider, windowEndsAt));
                assertEq(dueSinceIn(buyAs(vault, stranger, holder)), dueSince, "Bought's dueSince is status()'s");
            } else {
                assertTrue(isDue, "due");
                assertEq(dueSinceIn(buyAs(vault, outsider, outsider)), dueSince, "Bought's dueSince is status()'s");
            }
            vm.revertToState(snapshot);
        }
    }

    // ─── A window always ends inside its slot ────────────────────────────────────

    /// Whatever the interval, the window, the start and when the last buy was made: the next
    /// buy falls due at most half an interval into its slot, its window ends inside that slot
    /// with at least a quarter of the slot left open to anyone, and `execute` agrees with
    /// `status()` at the window's last second and its end. Few runs: each makes a vault, an
    /// upstream account fetch on the fork.
    /// forge-config: default.fuzz.runs = 64
    function testFuzz_aWindowAlwaysEndsInsideItsSlot(
        uint256 intervalSeed,
        uint256 windowSeed,
        uint256 startSeed,
        uint256 lastSeed,
        uint256 nowSeed
    ) public {
        Plan memory p = defaultPlan();
        p.interval = 300 + intervalSeed % (366 days - 300 + 1);
        uint256 longest = p.interval / 4 < 1 hours ? p.interval / 4 : 1 hours;
        p.communityWindow = 60 + windowSeed % (longest - 60 + 1);
        p.startAt = block.timestamp + startSeed % 1 days;
        p.maxBuys = 3;
        SpdexDcaVault vault = createFunded(p);

        // The last buy, at any moment of the first three slots.
        vm.warp(p.startAt + lastSeed % (3 * p.interval));
        buyAs(vault, owner, owner);
        // Now: any moment from when the next buy is allowed, up to three slots on.
        uint256 nextBuyAt = nextBuyAtOf(vault);
        vm.warp(nextBuyAt + nowSeed % (3 * p.interval));

        (uint256 dueSince, uint256 windowEndsAt) = windowOf(vault);
        uint256 slotStart = p.startAt + ((block.timestamp - p.startAt) / p.interval) * p.interval;
        assertGe(dueSince, slotStart, "due no earlier than its slot's start");
        assertGe(dueSince, nextBuyAt, "nor than the clock allows");
        assertTrue(dueSince <= block.timestamp, "and already due");
        assertTrue(dueSince <= slotStart + p.interval / 2, "at most half an interval into its slot");
        assertEq(windowEndsAt, dueSince + p.communityWindow, "the window is the plan's");
        assertTrue(
            windowEndsAt + p.interval / 4 <= slotStart + p.interval,
            "it ends inside its slot, leaving at least a quarter of it open to anyone"
        );

        if (block.timestamp < windowEndsAt) {
            vm.warp(windowEndsAt - 1);
            expectRefusal(vault, outsider, outsider, notEligible(outsider, windowEndsAt));
        }
        vm.warp(windowEndsAt);
        assertEq(dueSinceIn(buyAs(vault, outsider, outsider)), dueSince, "and the buy at its end agrees");
    }

    // ─── Decision 11: whom it pays is all the caller chooses ─────────────────────

    /// For any two `rewardTo` values the vault accepts at the same moment — the owner, either
    /// of two eligible addresses, and after the window any address at all — the buy is byte
    /// for byte the same: what the owner receives, what the pair is left holding, the slot,
    /// `buyNumber`, the floor and depth in `Bought`, the vault's state. Only who is paid the
    /// fee differs, and with it whether the buy counts in `windowBuys`. This is what makes the
    /// one argument `execute` takes harmless: it names nothing about the buy.
    /// forge-config: default.fuzz.runs = 128
    function testFuzz_anyTwoAcceptedRewardTosMakeTheSameBuy(
        uint256 kindA,
        uint256 kindB,
        address anyone,
        uint256 offset,
        bool afterWindow,
        bool laterBuy
    ) public {
        Plan memory p = defaultPlan();
        SpdexDcaVault vault = createFunded(p);
        uint256 base = p.startAt;
        if (laterBuy) {
            buyAs(vault, owner, owner);
            base += p.interval;
        }
        vm.warp(
            afterWindow
                ? base + p.communityWindow + offset % (p.interval - p.communityWindow)
                : base + offset % p.communityWindow
        );
        // An address that would be anything but the fee's recipient is not "any address": the
        // vault itself (refused), zero (refused), and the pair, whose WETH balance is the buy's.
        if (anyone == address(0) || anyone == address(vault) || anyone == SPX_WETH_PAIR) anyone = outsider;

        address a = pick(kindA, afterWindow, anyone);
        address b = pick(kindB, afterWindow, anyone);
        Outcome memory x = outcomeOf(vault, a);
        Outcome memory y = outcomeOf(vault, b);

        assertEq(x.received, y.received, "the same amount out");
        assertEq(x.ownerSpxDelta, y.ownerSpxDelta, "the same SPX to the owner");
        assertEq(x.ownerSpxDelta, x.received, "which is what execute reports");
        assertEq(x.boughtData, y.boughtData, "Bought's data byte for byte: amounts, floor, buyNumber, depth, dueSince");
        assertEq(x.slotTopic, y.slotTopic, "the same slot");
        assertEq(x.keeperTopic, y.keeperTopic, "the same caller");
        assertEq(x.vaultWeth, y.vaultWeth, "the same WETH left in the vault");
        assertEq(x.buysDone, y.buysDone, "the same buyNumber");
        assertEq(x.lastBuyAt, y.lastBuyAt, "the same lastBuyAt");
        assertEq(x.totalOut, y.totalOut, "the same totalOut");
        assertEq(x.pairReserveWeth, y.pairReserveWeth, "the pair left the same");
        assertEq(x.pairReserveSpx, y.pairReserveSpx, "both ways");
        // Only who was paid differs.
        assertEq(x.reward, p.keeperReward, "the fee");
        assertEq(y.reward, p.keeperReward, "the same fee");
        assertEq(x.paidWethDelta, p.keeperReward, "paid to the first rewardTo");
        assertEq(y.paidWethDelta, p.keeperReward, "paid to the second");
        assertEq(x.rewardTo, a, "Bought names the first");
        assertEq(y.rewardTo, b, "Bought names the second");
        assertEq(x.windowBuys, !afterWindow && a != owner ? 1 : 0, "counted as the window rule says");
        assertEq(y.windowBuys, !afterWindow && b != owner ? 1 : 0, "for each");
    }

    /// The owner, `holder`, `holder2`; and, after the window, `anyone`.
    function pick(uint256 kind, bool afterWindow, address anyone) internal view returns (address) {
        kind %= afterWindow ? 4 : 3;
        return kind == 0 ? owner : kind == 1 ? holder : kind == 2 ? holder2 : anyone;
    }

    /// `keeper` makes the buy paying `rewardTo`; what it did, then undone.
    function outcomeOf(SpdexDcaVault vault, address rewardTo) internal returns (Outcome memory o) {
        uint256 snapshot = vm.snapshotState();
        uint256 spx0 = spxOf(owner);
        uint256 weth0 = wethOf(rewardTo);
        vm.recordLogs();
        vm.prank(keeper);
        (o.received, o.reward) = vault.execute(rewardTo);
        VmLog memory log = boughtIn(vm.getRecordedLogs(), address(vault));
        o.ownerSpxDelta = spxOf(owner) - spx0;
        o.paidWethDelta = wethOf(rewardTo) - weth0;
        o.slotTopic = log.topics[1];
        o.keeperTopic = log.topics[2];
        o.rewardTo = rewardToIn(log);
        o.boughtData = log.data;
        o.vaultWeth = wethOf(address(vault));
        o.buysDone = vault.buysDone();
        o.lastBuyAt = vault.lastBuyAt();
        o.totalOut = vault.totalOut();
        o.windowBuys = vault.windowBuys();
        (uint112 reserveWeth, uint112 reserveSpx,) = IV2PairTest(SPX_WETH_PAIR).getReserves();
        (o.pairReserveWeth, o.pairReserveSpx) = (reserveWeth, reserveSpx);
        vm.revertToState(snapshot);
    }
}
