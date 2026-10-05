// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.33;

import {ForkTest, Plan} from "./utils/Fork.sol";
import {console} from "./utils/Test.sol";
import {SpdexDcaVault} from "../../contracts/SpdexDcaVault.sol";
import {SpdexVaultBatcher} from "../../contracts/SpdexVaultBatcher.sol";
import {SpdexVaultFactory} from "../../contracts/SpdexVaultFactory.sol";

/// Turns: a plan may share the first half of each community window out among buckets of
/// holders (`turnBuckets`), the address-hash scheme `docs/V2_UPGRADE.md` set aside as the
/// first thing to look at should decision 29 trip. It ships unused — every vault the app
/// creates has none — so these tests pin two things: that a vault without turns behaves
/// exactly as the window's own tests say, and that a vault with them does what its header
/// says, to the second, so that the app can start creating them without anything new being
/// deployed.
contract TurnsTest is ForkTest {
    /// Four buckets: about one buy in four is each holder's first.
    uint256 internal constant K = 4;

    function turnsPlan() internal view returns (Plan memory p) {
        p = defaultPlan();
        p.turnBuckets = K;
    }

    /// The bucket a vault puts `holder` in, worked out here rather than asked.
    function bucket(address holder, uint256 k) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(holder))) % k;
    }

    /// An eligible address in bucket `b` (when `inIt`) or out of it, for `k` buckets.
    function holderIn(uint256 b, uint256 k, bool inIt, string memory name) internal returns (address holder) {
        for (uint256 i;; i++) {
            holder = fresh(string.concat(name, "-", vm.toString(i)));
            if ((bucket(holder, k) == b) == inIt) break;
        }
        makeEligible(holder);
    }

    function statusTurn(SpdexDcaVault vault)
        internal
        view
        returns (uint256 dueSince, uint256 windowEndsAt, uint256 turnEndsAt, uint256 turn)
    {
        (,,,,, dueSince, windowEndsAt, turnEndsAt, turn) = vault.status();
    }

    // ─── Without turns ───────────────────────────────────────────────────────────

    /// A plan without turns (0, every vault the app creates) has no turn part: status says it
    /// ends where the window starts, every address is in bucket 0, and any eligible holder may
    /// be paid from the first second of the window.
    function test_withoutTurnsAnyEligibleHolderMayBePaidFromTheStart() public {
        SpdexDcaVault vault = createFunded(defaultPlan());
        assertEq(vault.terms().turnBuckets, 0, "no turns");
        (uint256 dueSince,, uint256 turnEndsAt, uint256 turn) = statusTurn(vault);
        assertEq(turnEndsAt, dueSince, "no turn part");
        assertEq(turn, 0, "no turn");
        assertEq(vault.bucketOf(keeper), 0, "every address in the one bucket");
        assertEq(vault.turnOf(7), 0, "every slot draws it");

        vm.prank(stranger);
        vault.execute(keeper);
        assertEq(vault.windowBuys(), 1, "an eligible holder bought at the window's first second");
    }

    // ─── The term ────────────────────────────────────────────────────────────────

    /// None, or 2 to 64: one bucket is no turns spelt another way, and refused.
    function test_turnsAreNoneOrTwoToTheMost() public {
        uint256 most = factory.MAX_TURN_BUCKETS();
        assertEq(most, 64, "MAX_TURN_BUCKETS");
        Plan memory p = defaultPlan();
        uint256[2] memory refused = [uint256(1), most + 1];
        for (uint256 i; i < 2; i++) {
            p.turnBuckets = refused[i];
            vm.prank(owner);
            (bool ok, bytes memory returned) = address(factory).call(createCall(p));
            assertTrue(!ok, "refused");
            assertEq(
                returned,
                abi.encodeWithSelector(SpdexVaultFactory.TurnsOutOfRange.selector, refused[i], most),
                "TurnsOutOfRange, with the most"
            );
        }
        uint256[3] memory accepted = [uint256(0), 2, most];
        for (uint256 i; i < 3; i++) {
            p.turnBuckets = accepted[i];
            assertEq(create(p).terms().turnBuckets, accepted[i], "accepted, and held as given");
        }
    }

    /// The vault's own answers are the hashes its header names, so a keeper or the app can
    /// work them out for any vault and slot without asking.
    function testFuzz_bucketAndTurnAreTheHashes(address holder, uint256 slot, uint8 k) public {
        k = uint8(2 + uint256(k) % 63);
        Plan memory p = defaultPlan();
        p.turnBuckets = k;
        SpdexDcaVault vault = create(p);
        assertEq(vault.bucketOf(holder), uint256(keccak256(abi.encode(holder))) % k, "bucketOf");
        assertEq(vault.turnOf(slot), uint256(keccak256(abi.encode(address(vault), slot))) % k, "turnOf");
    }

    // ─── With turns ──────────────────────────────────────────────────────────────

    /// The first half of the window, to the second: an eligible holder in the slot's bucket
    /// may be paid, one in another bucket is refused `NotYourTurn` with the turn and when it
    /// ends, an address that is not eligible is refused `NotEligible` as ever, and the owner
    /// may always be paid.
    function test_theFirstHalfOfTheWindowIsTheBucketsAlone() public {
        Plan memory p = turnsPlan();
        SpdexDcaVault vault = createFunded(p);
        uint256 turn = vault.turnOf(0);
        (uint256 dueSince, uint256 windowEndsAt, uint256 turnEndsAt, uint256 statusTurn_) = statusTurn(vault);
        assertEq(dueSince, p.startAt, "due from the start");
        assertEq(turnEndsAt, dueSince + p.communityWindow / 2, "the turn is the window's first half");
        assertEq(statusTurn_, turn, "status gives the slot's turn");
        assertEq(windowEndsAt, dueSince + p.communityWindow, "the window as ever");

        address onTurn = holderIn(turn, K, true, "on-turn");
        address offTurn = holderIn(turn, K, false, "off-turn");
        address outsider = fresh("outsider");
        assertEq(vault.bucketOf(onTurn), turn, "in the turn's bucket");

        uint256[2] memory moments = [dueSince, turnEndsAt - 1];
        for (uint256 i; i < 2; i++) {
            vm.warp(moments[i]);
            uint256 snapshot = vm.snapshotState();
            vm.prank(stranger);
            vm.expectRevert(
                abi.encodeWithSelector(SpdexDcaVault.NotYourTurn.selector, offTurn, turn, turnEndsAt)
            );
            vault.execute(offTurn);
            vm.prank(stranger);
            vm.expectRevert(abi.encodeWithSelector(SpdexDcaVault.NotEligible.selector, outsider, windowEndsAt));
            vault.execute(outsider);

            vm.prank(stranger);
            vault.execute(onTurn);
            assertEq(vault.windowBuys(), 1, "the turn's holder bought: a window buy");
            vm.revertToState(snapshot);

            vm.prank(owner);
            vault.execute(owner);
            assertEq(vault.windowBuys(), 0, "the owner may always be paid, and it is not a window buy");
            vm.revertToState(snapshot);
        }
    }

    /// From `turnEndsAt` to the window's end, any eligible holder; from the window's end,
    /// anyone. The turn only ever narrows the window's first half.
    function test_afterTheTurnAnyEligibleHolderAndAfterTheWindowAnyone() public {
        Plan memory p = turnsPlan();
        SpdexDcaVault vault = createFunded(p);
        uint256 turn = vault.turnOf(0);
        (, uint256 windowEndsAt, uint256 turnEndsAt,) = statusTurn(vault);
        address offTurn = holderIn(turn, K, false, "off-turn");
        address outsider = fresh("outsider");

        vm.warp(turnEndsAt);
        uint256 snapshot = vm.snapshotState();
        vm.prank(stranger);
        vault.execute(offTurn);
        assertEq(vault.windowBuys(), 1, "any eligible holder, from the turn's end");
        vm.revertToState(snapshot);

        vm.warp(windowEndsAt - 1);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(SpdexDcaVault.NotEligible.selector, outsider, windowEndsAt));
        vault.execute(outsider);

        vm.warp(windowEndsAt);
        vm.prank(stranger);
        vault.execute(outsider);
        assertEq(vault.windowBuys(), 0, "anyone, from the window's end: not a window buy");
    }

    /// Each slot draws its own turn, and each vault its own: the next slot's buy is measured
    /// from its own `dueSince`, and `status` follows the clock into it.
    function test_eachSlotDrawsItsOwnTurn() public {
        Plan memory p = turnsPlan();
        SpdexDcaVault vault = createFunded(p);
        vm.prank(owner);
        vault.execute(owner);

        vm.warp(p.startAt + p.interval);
        (uint256 dueSince,, uint256 turnEndsAt, uint256 turn) = statusTurn(vault);
        assertEq(dueSince, p.startAt + p.interval, "the second slot's buy falls due at its start");
        assertEq(turn, vault.turnOf(1), "and draws slot 1's turn");
        assertEq(turnEndsAt, dueSince + p.communityWindow / 2, "its own turn part");

        address onTurn = holderIn(turn, K, true, "slot-1");
        vm.prank(stranger);
        vault.execute(onTurn);
        assertEq(vault.windowBuys(), 1, "slot 1's holder bought in slot 1's turn");

        // Over many slots and two vaults, every bucket comes up, and the vaults' turns differ.
        SpdexDcaVault other = create(p);
        uint256 seen;
        uint256 differ;
        for (uint256 slot; slot < 64; slot++) {
            seen |= 1 << vault.turnOf(slot);
            if (vault.turnOf(slot) != other.turnOf(slot)) differ++;
        }
        assertEq(seen, (1 << K) - 1, "every bucket's turn comes up");
        assertGt(differ, 16, "two vaults' turns fall differently");
        console.log("slots of 64 in which two vaults' turns differ", differ);
    }

    /// A batch for a holder off its turn buys the vaults whose turn it is and records
    /// `NotYourTurn` for the rest, as it records any refusal: the vault decides.
    function test_aBatchOffItsTurnRecordsNotYourTurn() public {
        Plan memory p = turnsPlan();
        SpdexDcaVault a = createFunded(p);
        SpdexDcaVault b = createFunded(p);
        // A holder whose turn it is on `a` and not on `b`, when their turns differ; else the
        // test picks the next pair.
        while (a.turnOf(0) == b.turnOf(0)) {
            b = createFunded(p);
        }
        address holder = holderIn(a.turnOf(0), K, true, "batch-holder");
        SpdexVaultBatcher batcher = deployBatcher();

        vm.prank(keeper);
        (uint256 bought,, bytes4[] memory reasons) = batcher.executeBatch(_two(a, b), holder, 0, BATCH_GAS);
        assertEq(bought, 1, "the vault whose turn it is bought");
        assertEq(reasons[0], bytes4(0), "a");
        assertEq(reasons[1], SpdexDcaVault.NotYourTurn.selector, "b: NotYourTurn");
    }

    function _two(SpdexDcaVault a, SpdexDcaVault b) private pure returns (address[] memory list) {
        list = new address[](2);
        (list[0], list[1]) = (address(a), address(b));
    }

    /// What turns cost a buy: the hashes, inside the window's first half, for a plan that has
    /// them; one comparison for a plan without. Each buy measured from cold, as the first of
    /// a transaction.
    function test_whatTurnsCostABuy() public {
        Plan memory p = defaultPlan();
        SpdexDcaVault plain = createFunded(p);
        p.turnBuckets = K;
        SpdexDcaVault turned = createFunded(p);
        address onTurn = holderIn(turned.turnOf(0), K, true, "gas-holder");

        uint256 snapshot = vm.snapshotState();
        uint256 plainGas = coldBuyGas(plain, onTurn);
        vm.revertToState(snapshot);
        uint256 turnedGas = coldBuyGas(turned, onTurn);
        console.log("a window buy without turns", plainGas);
        console.log("a window buy inside its turn", turnedGas);
        assertLt(turnedGas, plainGas + 1_500, "the turn costs two hashes and a little arithmetic");
    }

    function coldBuyGas(SpdexDcaVault vault, address rewardTo) internal returns (uint256 used) {
        address[9] memory touched =
            [address(vault), factory.implementation(), registry, SPX, WETH, SPX_WETH_PAIR, SPX_WETH_POOL, owner, rewardTo];
        for (uint256 i; i < touched.length; i++) {
            vm.cool(touched[i]);
        }
        vm.prank(stranger);
        uint256 g = gasleft();
        vault.execute(rewardTo);
        used = g - gasleft();
    }
}
