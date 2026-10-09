// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.33;

import {ForkTest, IERC20Test, Plan, RecordedProof} from "./utils/Fork.sol";
import {VmLog} from "./utils/Test.sol";
import {SpdexDcaVault} from "../../contracts/SpdexDcaVault.sol";
import {SpdexVaultBatcher} from "../../contracts/SpdexVaultBatcher.sol";
import {SpxHolderRegistry} from "../../contracts/SpxHolderRegistry.sol";

/// Cheatcodes this file needs beyond the shared harness.
interface VmHolder {
    function etch(address target, bytes calldata code) external;
}

/// Uniswap v2's pair hands anyone who asks whatever it holds above its reserves.
interface ISkimmable {
    function skim(address to) external;
}

/// An outside bot with no SPX of its own, no proof and no loan, that names Uniswap v2's
/// SPX/WETH pair as `rewardTo`. The pair holds 13 million SPX, so a true proof of it is easy
/// to send, and a fee paid to it sits above its reserves, where `skim` hands it to the bot in
/// the same transaction. SPX refuses a transfer of nothing, so one raw unit (1e-8 SPX) goes
/// in first, and comes straight back out with the fee.
contract SkimBot {
    function run(SpdexDcaVault vault, address pair, address spx) external {
        vault.execute(pair);
        IERC20Test(spx).transfer(pair, 1);
        ISkimmable(pair).skim(address(this));
    }
}

/// The whole path a community keeper takes, with a real SPX holder and nothing written by
/// hand: the holder proven by a fresh key from a proof recorded from mainnet, against the real
/// registry at its mainnet address, and then paid for buys made inside their community
/// windows, by a vault directly and through the batcher. And the holder a buy may not pay: a
/// real one 91.2 SPX short, who can neither prove nor be paid until the window ends.
///
/// The holders never sign anything (only `HOLDER` moving its own SPX, which is the point of
/// that test): fresh keys send every transaction, as on the shared fork, where only the
/// eligible address is borrowed (`docs/DESIGN.md`, "How it is tested"). `Registry.t.sol`
/// is the registry's own suite; this file is the registry and the vault together.
contract HolderTest is ForkTest {
    VmHolder internal constant vmh = VmHolder(address(uint160(uint256(keccak256("hevm cheat code")))));
    /// Uniswap v2's SPX/WETH pair, proven from mainnet at the same block as `HOLDER_PROOF`.
    string internal constant PAIR_PROOF = "holder-52c77b0c-25999900.json";

    SpdexVaultBatcher internal batcher;

    function setUp() public override {
        super.setUp();
        batcher = deployBatcher();
    }

    function reg() internal view returns (SpxHolderRegistry) {
        return SpxHolderRegistry(registry);
    }

    function notEligible(address rewardTo, uint256 windowEndsAt) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(SpdexDcaVault.NotEligible.selector, rewardTo, windowEndsAt);
    }

    function threeVaults(Plan memory p) internal returns (address[] memory vaults) {
        vaults = new address[](3);
        for (uint256 i; i < 3; i++) {
            vaults[i] = address(createFunded(p));
        }
    }

    function nothingBought(uint256 n) internal pure returns (bytes memory) {
        bytes4[] memory reasons = new bytes4[](n);
        for (uint256 i; i < n; i++) {
            reasons[i] = SpdexDcaVault.NotEligible.selector;
        }
        return abi.encodeWithSelector(SpdexVaultBatcher.NothingBought.selector, reasons);
    }

    /// The real holder, unproven, is refused inside the window although it holds 1,210 SPX:
    /// holding is not enough without a proof. Proven by a fresh key from its recorded proof,
    /// it is recorded until the proven block's time plus 30 days, and the same call then buys,
    /// pays it the fee, says so in `Bought`, and counts as a community buy.
    function test_aRealHolderProvenFromItsMainnetProofIsPaidInsideTheWindow() public {
        Plan memory p = defaultPlan();
        SpdexDcaVault vault = createFunded(p);
        uint256 ends = p.startAt + p.communityWindow;
        RecordedProof memory proof = recordedProof(HOLDER_PROOF);
        assertEq(proof.holder, HOLDER, "the recorded proof is the holder's");
        assertEq(HOLDER.code.length, 0, "the holder is an account with no code");
        assertGe(proof.balance, MIN_SPX, "it held at least 690 SPX at the proven block");
        assertGe(spxOf(HOLDER), MIN_SPX, "and holds at least that now");

        assertTrue(!reg().isEligible(HOLDER), "unproven, it is not eligible");
        vm.prank(keeper);
        vm.expectRevert(notEligible(HOLDER, ends));
        vault.execute(HOLDER);

        uint64 validUntil = proveRecorded(HOLDER_PROOF);
        assertEq(validUntil, proof.timestamp + 30 days, "valid for 30 days from the proven block's time");
        assertEq(reg().validUntil(HOLDER), validUntil, "and recorded");
        assertTrue(reg().isEligible(HOLDER), "eligible");

        uint256 before = wethOf(HOLDER);
        vm.recordLogs();
        vm.prank(keeper);
        (uint256 received, uint256 reward) = vault.execute(HOLDER);
        VmLog[] memory logs = vm.getRecordedLogs();
        assertLt(block.timestamp, ends, "inside the community window");
        assertGt(received, 0, "the owner received SPX");
        assertEq(reward, p.keeperReward, "the reward returned");
        assertEq(wethOf(HOLDER) - before, p.keeperReward, "paid to the holder");
        assertEq(wethOf(keeper), 0, "not to the keeper that sent it");
        assertEq(vault.windowBuys(), 1, "a community buy");
        assertEq(bought(logs, address(vault)), 1, "one Bought");
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == address(vault) && logs[i].topics[0] == BOUGHT_TOPIC) {
                assertEq(logs[i].topics[2], bytes32(uint256(uint160(keeper))), "the caller, indexed");
                assertEq(logs[i].topics[3], bytes32(uint256(uint160(HOLDER))), "rewardTo, indexed: the holder");
            }
        }
    }

    /// The same through the batcher, as a community keeper sends buys: unproven, the holder's
    /// batch buys nothing and reverts with each vault's `NotEligible`; proven, every vault in
    /// it buys inside its window and pays the holder directly, and `minRewards` set to the
    /// whole sum is met.
    function test_aRealHolderProvenFromItsMainnetProofIsPaidThroughTheBatcher() public {
        Plan memory p = defaultPlan();
        address[] memory vaults = threeVaults(p);

        vm.prank(keeper);
        vm.expectRevert(nothingBought(3));
        batcher.executeBatch(vaults, HOLDER, 0, BATCH_GAS);

        proveRecorded(HOLDER_PROOF);
        uint256 before = wethOf(HOLDER);
        vm.prank(keeper);
        (uint256 boughtCount, uint256 earned, bytes4[] memory reasons) =
            batcher.executeBatch(vaults, HOLDER, 3 * p.keeperReward, BATCH_GAS);
        assertLt(block.timestamp, p.startAt + p.communityWindow, "inside the community windows");
        assertEq(boughtCount, 3, "every vault bought");
        assertEq(earned, 3 * p.keeperReward, "earned every reward");
        assertEq(wethOf(HOLDER) - before, earned, "paid to the holder");
        assertEq(wethOf(address(batcher)), 0, "nothing passed through the batcher");
        for (uint256 i; i < 3; i++) {
            assertEq(reasons[i], bytes4(0), "no refusal");
            assertEq(SpdexDcaVault(payable(vaults[i])).windowBuys(), 1, "a community buy");
        }
    }

    /// A real holder of 598.8 SPX, 91.2 short. Its true proof at the pinned block is refused
    /// with the shortfall, so it cannot become eligible. Inside the window a buy naming it is
    /// refused, directly and in a batch. Even a record left from an earlier proof (written
    /// here, as if it had held 690 SPX last week) does not help: the balance check at the
    /// moment of the buy refuses it. After the window anyone may be paid, so it is.
    function test_aHolderBelowTheMinimumCanNeitherProveNorBePaidInsideTheWindow() public {
        RecordedProof memory proof = recordedProof(SHORT_HOLDER_PROOF);
        assertEq(proof.holder, SHORT_HOLDER, "the recorded proof is the short holder's");
        assertEq(proof.blockNumber, FORK_BLOCK, "of the pinned block");
        assertEq(spxOf(SHORT_HOLDER), proof.balance, "what it holds now is what it was proven to hold");
        assertLt(proof.balance, MIN_SPX, "short of 690 SPX");

        // The pinned block's hash is readable once the chain has moved past it.
        vm.roll(block.number + 1);
        vm.prank(fresh("prover"));
        vm.expectRevert(abi.encodeWithSelector(SpxHolderRegistry.BelowMinimum.selector, proof.balance, MIN_SPX));
        reg().prove(SHORT_HOLDER, proof.header, proof.accountProof, proof.storageProof);
        assertEq(reg().validUntil(SHORT_HOLDER), 0, "nothing recorded");

        Plan memory p = defaultPlan();
        SpdexDcaVault vault = createFunded(p);
        uint256 ends = p.startAt + p.communityWindow;
        vm.prank(keeper);
        vm.expectRevert(notEligible(SHORT_HOLDER, ends));
        vault.execute(SHORT_HOLDER);
        address[] memory one = new address[](1);
        one[0] = address(vault);
        vm.prank(keeper);
        vm.expectRevert(nothingBought(1));
        batcher.executeBatch(one, SHORT_HOLDER, 0, BATCH_GAS);

        vm.store(registry, keccak256(abi.encode(SHORT_HOLDER, uint256(0))), bytes32(uint256(block.timestamp + 7 days)));
        assertTrue(!reg().isEligible(SHORT_HOLDER), "a record, but not the SPX");
        vm.prank(keeper);
        vm.expectRevert(notEligible(SHORT_HOLDER, ends));
        vault.execute(SHORT_HOLDER);

        vm.warp(ends);
        uint256 before = wethOf(SHORT_HOLDER);
        vm.prank(keeper);
        batcher.executeBatch(one, SHORT_HOLDER, 0, BATCH_GAS);
        assertEq(wethOf(SHORT_HOLDER) - before, p.keeperReward, "after the window it is paid like anyone");
        assertEq(vault.windowBuys(), 0, "not a community buy");
    }

    /// A proven holder that moves its SPX elsewhere stops being eligible at once, though its
    /// proof has weeks to run, and is eligible again as soon as it holds 690 SPX: exactly 690
    /// is enough. The proof is of the past; the check at the buy is of now.
    function test_aProvenHolderThatMovesItsSpxAwayIsNotPaidUntilItHoldsAgain() public {
        proveRecorded(HOLDER_PROOF);
        Plan memory p = defaultPlan();
        SpdexDcaVault vault = createFunded(p);
        uint256 ends = p.startAt + p.communityWindow;

        address elsewhere = fresh("elsewhere");
        uint256 held = spxOf(HOLDER);
        vm.prank(HOLDER);
        IERC20Test(SPX).transfer(elsewhere, held);
        assertTrue(!reg().isEligible(HOLDER), "proven, but holding nothing");
        vm.prank(keeper);
        vm.expectRevert(notEligible(HOLDER, ends));
        vault.execute(HOLDER);

        vm.prank(elsewhere);
        IERC20Test(SPX).transfer(HOLDER, MIN_SPX - 1);
        assertTrue(!reg().isEligible(HOLDER), "one unit short");
        vm.prank(elsewhere);
        IERC20Test(SPX).transfer(HOLDER, 1);
        assertTrue(reg().isEligible(HOLDER), "exactly 690 SPX");
        uint256 before = wethOf(HOLDER);
        vm.prank(keeper);
        vault.execute(HOLDER);
        assertEq(wethOf(HOLDER) - before, p.keeperReward, "paid inside the window");
    }

    // ─── Holders with code ───────────────────────────────────────────────────────

    /// Uniswap v2's SPX/WETH pair held 13.1 million SPX at the proven block, and anyone may
    /// prove anyone, so its true mainnet proof is recorded like any holder's. But a contract
    /// can hand what it is paid to whoever asks: the pair's `skim` gives a fee paid to it to
    /// the bot that called, in the same transaction, which would let a bot with no SPX, no
    /// proof and no loan take every window's fee. So an address with code is never eligible,
    /// whatever it holds and proved: inside the window the vault refuses it, directly, from
    /// the bot and in a batch. After the window anyone may be paid, the pair and its skimmer
    /// included, exactly as any outsider after the window.
    function test_aProvenContractThatHandsOutWhatItIsPaidIsNeverEligible() public {
        RecordedProof memory proof = recordedProof(PAIR_PROOF);
        assertEq(proof.holder, SPX_WETH_PAIR, "the recorded proof is the pair's");
        assertGt(SPX_WETH_PAIR.code.length, 0, "a contract");
        uint64 validUntil = proveRecorded(PAIR_PROOF);
        assertEq(reg().validUntil(SPX_WETH_PAIR), validUntil, "a true proof is recorded: it states a fact");
        assertGe(spxOf(SPX_WETH_PAIR), MIN_SPX, "and the pair holds far more than 690 SPX now");
        assertTrue(!reg().isEligible(SPX_WETH_PAIR), "but it has code, so it is not eligible");

        Plan memory p = defaultPlan();
        SpdexDcaVault vault = createFunded(p);
        uint256 ends = p.startAt + p.communityWindow;
        SkimBot bot = new SkimBot();
        giveSpx(address(bot), 1);

        vm.prank(keeper);
        vm.expectRevert(notEligible(SPX_WETH_PAIR, ends));
        vault.execute(SPX_WETH_PAIR);
        vm.prank(stranger);
        vm.expectRevert(notEligible(SPX_WETH_PAIR, ends));
        bot.run(vault, SPX_WETH_PAIR, SPX);
        address[] memory one = new address[](1);
        one[0] = address(vault);
        vm.prank(keeper);
        vm.expectRevert(nothingBought(1));
        batcher.executeBatch(one, SPX_WETH_PAIR, 0, BATCH_GAS);
        assertEq(vault.buysDone(), 0, "nothing bought inside the window");
        assertEq(wethOf(address(bot)), 0, "and the bot took nothing");

        vm.warp(ends);
        vm.prank(stranger);
        bot.run(vault, SPX_WETH_PAIR, SPX);
        assertEq(wethOf(address(bot)), p.keeperReward, "after the window it is paid as any outsider is");
        assertEq(vault.windowBuys(), 0, "and it is not a community buy");
    }

    /// An address proven while it had no code — one a contract could later be deployed to,
    /// or an account that later delegates — is judged at the moment of each buy: with code
    /// on it, it is not eligible; with only an EIP-7702 delegation on it (`0xef0100` and the
    /// delegate's address), it is still the holder's own account, and it is.
    function test_eligibilityIsJudgedOnTheCodeAtTheMomentOfTheBuy() public {
        proveRecorded(HOLDER_PROOF);
        Plan memory p = defaultPlan();
        SpdexDcaVault vault = createFunded(p);
        uint256 ends = p.startAt + p.communityWindow;

        vmh.etch(HOLDER, address(new SkimBot()).code);
        assertTrue(!reg().isEligible(HOLDER), "proven without code; with code, not eligible");
        vm.prank(keeper);
        vm.expectRevert(notEligible(HOLDER, ends));
        vault.execute(HOLDER);

        // Whatever it delegates to: only the account's own key can delegate it, so it stays
        // the holder's own, and the 690 SPX in it are the holder's.
        vmh.etch(HOLDER, abi.encodePacked(hex"ef0100", address(new SkimBot())));
        assertTrue(reg().isEligible(HOLDER), "a delegation designator alone: eligible");
        uint256 before = wethOf(HOLDER);
        vm.prank(keeper);
        vault.execute(HOLDER);
        assertEq(wethOf(HOLDER) - before, p.keeperReward, "and paid inside the window");
        assertEq(vault.windowBuys(), 1, "a community buy");
    }
}
