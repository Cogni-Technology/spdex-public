// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.33;

import {Test, VmLog, console} from "./utils/Test.sol";
import {SpxHolderRegistry} from "../../contracts/SpxHolderRegistry.sol";
import {ISpxHolderRegistry} from "../../contracts/interfaces/ISpxHolderRegistry.sol";
import {RLPReader} from "../../contracts/vendor/optimism/rlp/RLPReader.sol";

// The SPX holder registry against real mainnet proofs: recorded by
// `scripts/record-proofs.mjs` from an archive endpoint for blocks at or before the pinned
// block (`test/fixtures/proofs`), and checked here on a fork of that block, whose
// `BLOCKHASH` and EIP-2935 history contract hold those blocks' real hashes. A local fork
// cannot prove a block it mined (its `stateRoot` is zero), so every proof here is a real
// one, or a real one damaged on purpose.
//
// What it pins: each real proof proves through the path its age calls for, and the paths'
// edges to the block; validity is counted from the proven block's time and is inclusive to
// the second; the balance check at the moment of the buy; `NotNewer`; anyone may prove
// anyone; every kind of false proof is refused, with the registry's own error wherever it
// names one; fuzzing of the header and of both proofs; and gas against the budgets the
// vault and the app size from.

/// Cheatcodes this file needs beyond the shared harness.
struct RegistryCallGas {
    uint64 gasLimit;
    uint64 gasTotalUsed;
    uint64 gasMemoryUsed;
    int64 gasRefunded;
    uint64 gasRemaining;
}

interface VmRegistry {
    function projectRoot() external view returns (string memory);
    function readFile(string calldata path) external view returns (string memory);
    function parseJsonAddress(string calldata json, string calldata key) external pure returns (address);
    function parseJsonUint(string calldata json, string calldata key) external pure returns (uint256);
    function parseJsonBytes32(string calldata json, string calldata key) external pure returns (bytes32);
    function parseJsonBytes(string calldata json, string calldata key) external pure returns (bytes memory);
    function parseJsonBytesArray(string calldata json, string calldata key) external pure returns (bytes[] memory);
    function etch(address target, bytes calldata code) external;
    function load(address target, bytes32 slot) external view returns (bytes32);
    function snapshotState() external returns (uint256);
    function revertToState(uint256 snapshotId) external returns (bool);
    /// Marks an account and every storage slot of it cold, as at the start of a transaction.
    function cool(address target) external;
    /// The gas the last call used, from the callee's side, with the refunds it earned.
    function lastCallGas() external view returns (RegistryCallGas memory);
}

interface IERC20Registry {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

/// One recorded proof: a holder's SPX balance at a mainnet block, with the block's header.
struct Fixture {
    address holder;
    uint256 blockNumber;
    bytes32 blockHash;
    bytes32 stateRoot;
    uint256 timestamp;
    uint256 balance;
    bytes header;
    bytes[] accountProof;
    bytes[] storageProof;
}

contract RegistryTest is Test {
    VmRegistry internal constant vmr = VmRegistry(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 internal constant FORK_BLOCK = 26_000_000;
    address internal constant SPX = 0xE0f63A424a4439cBE457D80E4f4b51aD25b2c56C;
    address internal constant HISTORY = 0x0000F90827F1C53a10cb7A02335B175320002935;
    uint256 internal constant MIN_SPX = 69_000_000_000;
    uint256 internal constant PROOF_TTL = 30 days;

    /// `ELIGIBILITY_GAS` in the v2 vault: the stipend `isEligible` is called with. A call
    /// that runs out counts as "not eligible", so the registry must fit it with room — room
    /// for a fork that reprices cold reads, since no vault can ever be given more.
    uint256 internal constant ELIGIBILITY_GAS = 100_000;
    /// What `prove` may use as a call, at most, for a real proof: measured at about 520,000
    /// to 550,000 for the recorded proofs (`test_proveFitsItsBudgetThroughEitherPath` logs
    /// each). Almost all of it is the vendored verifier decoding each trie node, about
    /// 25,000 gas per branch node, which is the price of not writing a verifier fresh.
    uint256 internal constant PROVE_GAS = 600_000;

    bytes32 internal constant PROVEN_TOPIC = keccak256("Proven(address,uint256,uint256,uint64)");

    /// 1,308.2354 SPX from 25,991,808 to 25,999,900, and 1,210 at the pinned block.
    address internal constant HOLDER = 0xb0072E684E532BD1dcC442b5ED22097db205Bb8e;
    /// 2,047 SPX at 25,995,000, 213 at 25,999,000, none at 25,999,900, 1,992 at the pinned block.
    address internal constant SELLER = 0xd75110Fc7a983E50e4B3A03434a8b524dB4B5b7E;
    /// About 598.8 SPX at the pinned block: short of the minimum.
    address internal constant SHORT = 0xCC01ef33f793Ff0a8dA26d19B2c4428F62753F85;

    // The recorded proofs, by what each is for. Ages are counted from the pinned block.
    /// 100 blocks back: `BLOCKHASH`.
    string internal constant NEAR = "holder-b0072e68-25999900.json";
    /// 5,000 blocks back: EIP-2935.
    string internal constant FAR = "holder-b0072e68-25995000.json";
    /// 8,100 blocks back: EIP-2935, near its edge.
    string internal constant EDGE = "holder-b0072e68-25991900.json";
    /// 256 blocks back: the oldest `BLOCKHASH` answers.
    string internal constant BLOCKHASH_OLDEST = "holder-b0072e68-25999744.json";
    /// 257 blocks back: the newest that needs EIP-2935.
    string internal constant HISTORY_NEWEST = "holder-b0072e68-25999743.json";
    /// 8,191 blocks back: the oldest EIP-2935 answers.
    string internal constant HISTORY_OLDEST = "holder-b0072e68-25991809.json";
    /// 8,192 blocks back: one too old.
    string internal constant TOO_OLD = "holder-b0072e68-25991808.json";
    /// The pinned block itself: the current block on this fork.
    string internal constant PINNED = "holder-b0072e68-26000000.json";
    /// A true proof of 213 SPX.
    string internal constant BELOW = "holder-d75110fc-25999000.json";
    /// No SPX: the balance key is absent from SPX's storage trie.
    string internal constant ABSENT = "holder-d75110fc-25999900.json";
    /// 2,047 SPX at 25,995,000, the same block as `FAR`.
    string internal constant SOLD = "holder-d75110fc-25995000.json";
    /// About 598.8 SPX at the pinned block.
    string internal constant SHORTFALL = "holder-cc01ef33-26000000.json";

    /// Code for the history contract's address that reverts whatever it is asked: the
    /// registry can then only prove through `BLOCKHASH`.
    bytes internal constant REVERTS = hex"5f5ffd"; // PUSH0 PUSH0 REVERT

    SpxHolderRegistry internal registry;

    function setUp() public {
        string memory url = vm.envOr("SPDEX_FORK_RPC_URL", string(""));
        if (bytes(url).length == 0) {
            fail("SPDEX_FORK_RPC_URL is not set: these tests fork mainnet at block 26000000 from an archive endpoint");
        }
        vm.createSelectFork(url, FORK_BLOCK);
        registry = new SpxHolderRegistry{salt: keccak256("spdex.vault.test/registry")}();
    }

    // ─── Fixtures ────────────────────────────────────────────────────────────────

    function load(string memory name) internal view returns (Fixture memory f) {
        string memory json = vmr.readFile(string.concat(vmr.projectRoot(), "/test/fixtures/proofs/", name));
        f.holder = vmr.parseJsonAddress(json, ".holder");
        f.blockNumber = vmr.parseJsonUint(json, ".blockNumber");
        f.blockHash = vmr.parseJsonBytes32(json, ".blockHash");
        f.stateRoot = vmr.parseJsonBytes32(json, ".stateRoot");
        f.timestamp = vmr.parseJsonUint(json, ".timestamp");
        f.balance = vmr.parseJsonUint(json, ".balance");
        f.header = vmr.parseJsonBytes(json, ".header");
        f.accountProof = vmr.parseJsonBytesArray(json, ".accountProof");
        f.storageProof = vmr.parseJsonBytesArray(json, ".storageProof");
    }

    /// The proofs of the holders who held at least the minimum, at every age that proves.
    function eligibleFixtures() internal pure returns (string[7] memory) {
        return [NEAR, FAR, EDGE, BLOCKHASH_OLDEST, HISTORY_NEWEST, HISTORY_OLDEST, SOLD];
    }

    function prove(Fixture memory f) internal returns (uint64) {
        return registry.prove(f.holder, f.header, f.accountProof, f.storageProof);
    }

    function proveCall(address holder, bytes memory header, bytes[] memory accountProof, bytes[] memory storageProof)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodeCall(SpxHolderRegistry.prove, (holder, header, accountProof, storageProof));
    }

    /// Whether `prove` with these arguments goes through, without keeping what it did.
    function proves(address holder, bytes memory header, bytes[] memory accountProof, bytes[] memory storageProof)
        internal
        returns (bool ok)
    {
        uint256 snapshot = vmr.snapshotState();
        (ok,) = address(registry).call(proveCall(holder, header, accountProof, storageProof));
        vmr.revertToState(snapshot);
    }

    /// Whether `f` proves while the history contract reverts everything: true only for a
    /// block `BLOCKHASH` still answers.
    function provesWithoutHistory(Fixture memory f) internal returns (bool ok) {
        uint256 snapshot = vmr.snapshotState();
        vmr.etch(HISTORY, REVERTS);
        (ok,) = address(registry).call(proveCall(f.holder, f.header, f.accountProof, f.storageProof));
        vmr.revertToState(snapshot);
    }

    /// Code for the history contract's address that answers `word` to anything, padded to
    /// `size` bytes.
    function answering(bytes32 word, uint8 size) internal pure returns (bytes memory) {
        // PUSH32 word, PUSH0, MSTORE, PUSH1 size, PUSH0, RETURN
        return bytes.concat(hex"7f", word, hex"5f5260", bytes1(size), hex"5ff3");
    }

    function age(Fixture memory f) internal view returns (uint256) {
        return block.number - f.blockNumber;
    }

    function copy(bytes memory data) internal pure returns (bytes memory out) {
        out = bytes.concat(data);
    }

    function copy(bytes[] memory list) internal pure returns (bytes[] memory out) {
        out = new bytes[](list.length);
        for (uint256 i; i < list.length; i++) {
            out[i] = copy(list[i]);
        }
    }

    function flipped(bytes memory data, uint256 offset, uint8 mask) internal pure returns (bytes memory out) {
        out = copy(data);
        out[offset] = bytes1(uint8(out[offset]) ^ mask);
    }

    function spxOf(address account) internal view returns (uint256) {
        return IERC20Registry(SPX).balanceOf(account);
    }

    // ─── RLP, for headers made wrong on purpose ──────────────────────────────────

    /// The header's fields, each as its own RLP bytes, in order.
    function fieldsOf(bytes memory header) internal pure returns (bytes[] memory raw) {
        RLPReader.RLPItem[] memory items = RLPReader.readList(header);
        raw = new bytes[](items.length);
        for (uint256 i; i < items.length; i++) {
            raw[i] = RLPReader.readRawBytes(items[i]);
        }
    }

    /// An RLP list of the first `count` of `fields`.
    function listOf(bytes[] memory fields, uint256 count) internal pure returns (bytes memory payload) {
        for (uint256 i; i < count; i++) {
            payload = bytes.concat(payload, fields[i]);
        }
        payload = bytes.concat(lengthPrefix(payload.length, 0xc0), payload);
    }

    /// `data` as an RLP string.
    function rlpString(bytes memory data) internal pure returns (bytes memory) {
        if (data.length == 1 && uint8(data[0]) < 0x80) return data;
        return bytes.concat(lengthPrefix(data.length, 0x80), data);
    }

    function lengthPrefix(uint256 length, uint8 offset) internal pure returns (bytes memory) {
        if (length < 56) return abi.encodePacked(uint8(offset + length));
        bytes memory digits = bigEndian(length);
        return bytes.concat(abi.encodePacked(uint8(offset + 55 + digits.length)), digits);
    }

    function bigEndian(uint256 value) internal pure returns (bytes memory out) {
        while (value != 0) {
            out = bytes.concat(abi.encodePacked(uint8(value)), out);
            value >>= 8;
        }
    }

    /// `value` big-endian, behind as many zero bytes as make it `width` bytes.
    function widened(uint256 value, uint256 width) internal pure returns (bytes memory digits) {
        digits = bigEndian(value);
        digits = bytes.concat(new bytes(width - digits.length), digits);
    }

    /// `header` with field `index` replaced by `field` (already RLP).
    function withField(bytes memory header, uint256 index, bytes memory field) internal pure returns (bytes memory) {
        bytes[] memory fields = fieldsOf(header);
        fields[index] = field;
        return listOf(fields, fields.length);
    }

    // ─── The fork, and the fixtures ──────────────────────────────────────────────

    /// What every test below rests on: each recorded header hashes to its block's hash, it
    /// has every field of its fork (21, after Prague), and this fork answers that same hash
    /// through `BLOCKHASH` for the last 256 blocks and through the history contract for the
    /// 8,191 before the current one, and through neither beyond.
    function test_theForkServesTheRealHashOfEveryRecordedBlock() public view {
        string[12] memory all = [
            NEAR,
            FAR,
            EDGE,
            BLOCKHASH_OLDEST,
            HISTORY_NEWEST,
            HISTORY_OLDEST,
            TOO_OLD,
            PINNED,
            BELOW,
            ABSENT,
            SOLD,
            SHORTFALL
        ];
        for (uint256 i; i < all.length; i++) {
            Fixture memory f = load(all[i]);
            assertEq(keccak256(f.header), f.blockHash, "the recorded header hashes to its block's hash");
            assertEq(fieldsOf(f.header).length, 21, "a header with every field of its fork");
            assertEq(keccak256(f.accountProof[0]), f.stateRoot, "the account proof starts at the state root");
            if (f.blockNumber >= block.number) continue;
            uint256 back = block.number - f.blockNumber;
            assertEq(blockhash(f.blockNumber), back <= 256 ? f.blockHash : bytes32(0), "BLOCKHASH: the last 256 only");
            (bool ok, bytes memory answer) = HISTORY.staticcall(abi.encode(f.blockNumber));
            if (back <= 8191) {
                assertTrue(ok && answer.length == 32, "the history contract answers the last 8,191");
                assertEq(bytes32(answer), f.blockHash, "with the block's real hash");
            } else {
                assertTrue(!ok, "and refuses anything older");
            }
        }
    }

    // ─── Real proofs, and the path each takes ────────────────────────────────────

    /// Every recorded proof of a holder with enough SPX proves, through `BLOCKHASH` when the
    /// block is one of the last 256 and through the history contract otherwise: with the
    /// history contract made to revert, exactly the young ones still prove. Each records
    /// the block's time plus 30 days, returns it, says so in `Proven`, and makes the holder
    /// eligible now (both hold more than the minimum at the pinned block).
    function test_everyRecordedEligibleProofProvesThroughThePathItsAgeCallsFor() public {
        string[7] memory names = eligibleFixtures();
        for (uint256 i; i < names.length; i++) {
            Fixture memory f = load(names[i]);
            assertTrue(provesWithoutHistory(f) == (age(f) <= 256), "BLOCKHASH for the last 256 blocks, history beyond");

            uint256 snapshot = vmr.snapshotState();
            assertTrue(!registry.isEligible(f.holder), "not eligible before proving");
            vm.recordLogs();
            uint64 until = prove(f);
            assertEq(until, f.timestamp + PROOF_TTL, "valid until the block's time plus 30 days");
            assertEq(registry.validUntil(f.holder), until, "recorded");
            assertProven(vm.getRecordedLogs(), f, until);
            assertTrue(registry.isEligible(f.holder), "eligible now");
            vmr.revertToState(snapshot);
        }
    }

    /// A block 100 back proves with the history contract gone entirely: `BLOCKHASH` alone.
    function test_aBlockWithin256ProvesThroughBlockhashAlone() public {
        Fixture memory f = load(NEAR);
        vmr.etch(HISTORY, "");
        assertEq(prove(f), f.timestamp + PROOF_TTL, "proven without the history contract");
        assertTrue(registry.isEligible(HOLDER), "eligible");
    }

    /// A block 5,000 back is `UnknownBlock` when the history contract reverts, and proves
    /// once it answers: the history contract is what proves it.
    function test_aBlockBeyond256ProvesThroughTheHistoryContractOnly() public {
        Fixture memory f = load(FAR);
        vmr.etch(HISTORY, REVERTS);
        vm.expectRevert(abi.encodeWithSelector(SpxHolderRegistry.UnknownBlock.selector, f.blockNumber));
        prove(f);

        Fixture memory g = load(FAR);
        vmr.etch(HISTORY, hex"");
        vm.expectRevert(abi.encodeWithSelector(SpxHolderRegistry.UnknownBlock.selector, g.blockNumber));
        prove(g);
    }

    /// The history contract's answer is the hash compared, not merely a yes: made to answer
    /// another hash, it turns a true proof 5,000 back into `WrongBlockHash` naming that
    /// hash, while a proof 100 back, which never asks it, still proves.
    function test_theHistoryContractsAnswerIsTheHashCompared() public {
        bytes32 wrong = keccak256("not the block's hash");
        vmr.etch(HISTORY, answering(wrong, 32));
        Fixture memory far = load(FAR);
        vm.expectRevert(abi.encodeWithSelector(SpxHolderRegistry.WrongBlockHash.selector, far.blockHash, wrong));
        prove(far);
        assertEq(prove(load(NEAR)), load(NEAR).timestamp + PROOF_TTL, "BLOCKHASH's path is untouched");
    }

    /// An answer of any other size than one word is no answer, even when its first word is
    /// the right hash: 64 bytes, or none.
    function test_aHistoryAnswerOfAnotherSizeIsUnknownBlock() public {
        Fixture memory f = load(FAR);
        vmr.etch(HISTORY, answering(f.blockHash, 64));
        vm.expectRevert(abi.encodeWithSelector(SpxHolderRegistry.UnknownBlock.selector, f.blockNumber));
        prove(f);
        vmr.etch(HISTORY, answering(f.blockHash, 0));
        vm.expectRevert(abi.encodeWithSelector(SpxHolderRegistry.UnknownBlock.selector, f.blockNumber));
        prove(f);
        vmr.etch(HISTORY, answering(f.blockHash, 32));
        assertEq(prove(f), f.timestamp + PROOF_TTL, "one word, the right hash: proven");
    }

    /// The edge between the two paths, to the block: 256 back proves through `BLOCKHASH`,
    /// 257 back needs the history contract.
    function test_theOldestBlockhashBlockAndTheNewestHistoryBlock() public {
        Fixture memory oldest = load(BLOCKHASH_OLDEST);
        Fixture memory newest = load(HISTORY_NEWEST);
        assertEq(age(oldest), 256, "256 back");
        assertEq(age(newest), 257, "257 back");
        assertTrue(provesWithoutHistory(oldest), "256 back: BLOCKHASH");
        assertTrue(!provesWithoutHistory(newest), "257 back: not BLOCKHASH");
        vmr.etch(HISTORY, REVERTS);
        vm.expectRevert(abi.encodeWithSelector(SpxHolderRegistry.UnknownBlock.selector, newest.blockNumber));
        prove(newest);
    }

    /// The far edge, to the block: 8,191 back proves through the history contract, and
    /// 8,192 back is `UnknownBlock`, though it is a true proof of a holder.
    function test_theOldestHistoryBlockProvesAndTheOneBeforeItIsUnknown() public {
        Fixture memory oldest = load(HISTORY_OLDEST);
        Fixture memory tooOld = load(TOO_OLD);
        assertEq(age(oldest), 8191, "8,191 back");
        assertEq(age(tooOld), 8192, "8,192 back");
        vm.expectRevert(abi.encodeWithSelector(SpxHolderRegistry.UnknownBlock.selector, tooOld.blockNumber));
        prove(tooOld);
        assertEq(prove(oldest), oldest.timestamp + PROOF_TTL, "8,191 back: proven");
    }

    /// The pinned block's own proofs, which the fork tests of the app and the keeper use,
    /// prove once the chain has moved past it: the eligible holder's, and the short one's
    /// is `BelowMinimum` with its figures.
    function test_thePinnedBlocksProofsProveOnceTheChainHasMovedPastIt() public {
        vm.roll(FORK_BLOCK + 1);
        vm.warp(block.timestamp + 12);
        Fixture memory f = load(PINNED);
        assertEq(prove(f), f.timestamp + PROOF_TTL, "the pinned block, one block later");
        Fixture memory s = load(SHORTFALL);
        assertEq(s.balance, 59_880_169_405, "about 598.8 SPX");
        vm.expectRevert(abi.encodeWithSelector(SpxHolderRegistry.BelowMinimum.selector, s.balance, MIN_SPX));
        prove(s);
    }

    // ─── Validity ────────────────────────────────────────────────────────────────

    /// A proof is valid through the second `validUntil` names, inclusive, and not one
    /// second more.
    function test_aProofIsValidThroughItsLastSecondAndNotOneMore() public {
        uint64 until = prove(load(NEAR));
        vm.warp(until - 1);
        assertTrue(registry.isEligible(HOLDER), "a second before");
        vm.warp(until);
        assertTrue(registry.isEligible(HOLDER), "the last second");
        vm.warp(uint256(until) + 1);
        assertTrue(!registry.isEligible(HOLDER), "a second after");
        assertEq(registry.validUntil(HOLDER), until, "the record stays; it has lapsed");
    }

    /// The 30 days count from the proven block's time, not from when the proof was sent: a
    /// proof sent ten days later lasts ten days less.
    function test_validityCountsFromTheProvenBlocksTimeNotFromWhenItIsSent() public {
        Fixture memory f = load(NEAR);
        vm.warp(block.timestamp + 10 days);
        assertEq(prove(f), f.timestamp + PROOF_TTL, "the block's time plus 30 days");
    }

    /// The balance is checked again at every call: a holder who moves SPX away below the
    /// minimum is not eligible, one unit short is not enough, exactly the minimum is, and
    /// none at all is not, while the proof itself stays recorded throughout.
    function test_aHolderWhoMovesSpxBelowTheMinimumIsNotEligibleUntilItIsBack() public {
        uint64 until = prove(load(NEAR));
        address sink = makeAddr("spdex.vault.test/sink");
        uint256 held = spxOf(HOLDER);
        assertGe(held, MIN_SPX, "the holder has enough at the pinned block");
        assertTrue(registry.isEligible(HOLDER), "eligible while holding it");

        vm.prank(HOLDER);
        IERC20Registry(SPX).transfer(sink, held - (MIN_SPX - 1));
        assertEq(spxOf(HOLDER), MIN_SPX - 1, "one unit short");
        assertTrue(!registry.isEligible(HOLDER), "one unit short of 690 SPX: not eligible");

        vm.prank(sink);
        IERC20Registry(SPX).transfer(HOLDER, 1);
        assertEq(spxOf(HOLDER), MIN_SPX, "exactly 690 SPX");
        assertTrue(registry.isEligible(HOLDER), "exactly the minimum: eligible again");

        vm.prank(HOLDER);
        IERC20Registry(SPX).transfer(sink, MIN_SPX);
        assertTrue(!registry.isEligible(HOLDER), "nothing left: not eligible");
        assertEq(registry.validUntil(HOLDER), until, "the proof is untouched by any of it");
    }

    /// Only an account may be paid as a holder: no code at all, or an EIP-7702 delegation
    /// designator and nothing else (`0xef0100` and a 20-byte address, 23 bytes), which only
    /// the account's own key can set. A contract can hand what it is paid to whoever asks —
    /// Uniswap v2's pair `skim`s it to anyone — so code of any other shape is not eligible,
    /// whatever it holds and proved, and it is judged at every call: an address proven while
    /// it had no code loses eligibility the moment code is put there, and has it back when
    /// the code is gone. The proof itself stays recorded throughout.
    function test_onlyAnAccountWithoutCodeOrWithOnlyADelegationIsEligible() public {
        uint64 until = prove(load(NEAR));
        assertEq(HOLDER.code.length, 0, "proven while it has no code");
        assertTrue(registry.isEligible(HOLDER), "eligible");

        address delegate = address(registry);
        vmr.etch(HOLDER, abi.encodePacked(hex"ef0100", delegate));
        assertTrue(registry.isEligible(HOLDER), "an EIP-7702 delegation: still the holder's account");

        // No other code can begin with 0xef on chain (EIP-3541 refuses it at deployment, and
        // a designator is always exactly these 23 bytes), and forge will not write it; so the
        // shapes that can exist are a contract's: 23 bytes that are not a designator, any
        // other length, a whole contract.
        bytes[5] memory notAccounts = [
            abi.encodePacked(hex"ee0100", delegate), // 23 bytes, one bit off the prefix
            abi.encodePacked(hex"000100", delegate),
            abi.encodePacked(bytes23(0)), // 23 bytes of STOP
            bytes(hex"00"), // one STOP
            address(registry).code // a whole contract
        ];
        for (uint256 i; i < notAccounts.length; i++) {
            vmr.etch(HOLDER, notAccounts[i]);
            assertTrue(!registry.isEligible(HOLDER), "code of any other shape: not eligible");
        }

        vmr.etch(HOLDER, "");
        assertTrue(registry.isEligible(HOLDER), "the code gone: eligible again");
        assertEq(registry.validUntil(HOLDER), until, "the proof is untouched by any of it");
    }

    /// Holding SPX is not enough without a proof: an address with 1,992 SPX that never
    /// proved is not eligible, and the zero address never is.
    function test_anAddressThatNeverProvedIsNotEligibleWhateverItHolds() public view {
        assertGt(spxOf(SELLER), MIN_SPX, "holds more than the minimum");
        assertEq(registry.validUntil(SELLER), 0, "never proved");
        assertTrue(!registry.isEligible(SELLER), "not eligible");
        assertTrue(!registry.isEligible(address(0)), "nor is the zero address");
    }

    /// Proving one holder changes nothing for any other.
    function test_aProofConcernsItsHolderAlone() public {
        prove(load(NEAR));
        assertEq(registry.validUntil(SELLER), 0, "another holder: untouched");
        assertTrue(!registry.isEligible(SELLER), "and still not eligible");
    }

    // ─── NotNewer, and who may prove ─────────────────────────────────────────────

    /// The same proof twice: the second would change nothing, so it is refused, naming
    /// what is recorded.
    function test_theSameProofAgainIsNotNewer() public {
        Fixture memory f = load(NEAR);
        uint64 until = prove(f);
        vm.expectRevert(abi.encodeWithSelector(ISpxHolderRegistry.NotNewer.selector, until));
        prove(f);
    }

    /// An older block than the one recorded is refused; a newer one extends the record.
    function test_anOlderBlockIsNotNewerAndANewerOneExtends() public {
        Fixture memory older = load(FAR);
        Fixture memory newer = load(NEAR);
        uint64 first = prove(older);

        vm.recordLogs();
        uint64 second = prove(newer);
        assertGt(second, first, "a newer block moves validUntil later");
        assertEq(second, newer.timestamp + PROOF_TTL, "to the newer block's time plus 30 days");
        assertEq(registry.validUntil(HOLDER), second, "recorded");
        assertProven(vm.getRecordedLogs(), newer, second);

        vm.expectRevert(abi.encodeWithSelector(ISpxHolderRegistry.NotNewer.selector, second));
        prove(older);
        vm.expectRevert(abi.encodeWithSelector(ISpxHolderRegistry.NotNewer.selector, second));
        prove(load(EDGE));
    }

    /// A proof states a fact about the chain, so whoever sends it, the result is the same:
    /// the holder named is recorded, and the sender is not.
    /// forge-config: default.fuzz.runs = 64
    function testFuzz_anyoneMayProveAnyHolder(address sender) public {
        Fixture memory f = load(NEAR);
        vm.prank(sender);
        uint64 until = prove(f);
        assertEq(until, f.timestamp + PROOF_TTL, "the same result whoever sends it");
        assertEq(registry.validUntil(HOLDER), until, "the holder named is recorded");
        if (sender != HOLDER) assertEq(registry.validUntil(sender), 0, "the sender is not");
        assertTrue(registry.isEligible(HOLDER), "and the holder is eligible");
    }

    // ─── False proofs ────────────────────────────────────────────────────────────

    /// The zero address can never be paid, so it can never be proven.
    function test_theZeroHolderIsRefused() public {
        Fixture memory f = load(NEAR);
        vm.expectRevert(abi.encodeWithSelector(SpxHolderRegistry.ZeroHolder.selector));
        registry.prove(address(0), f.header, f.accountProof, f.storageProof);
    }

    /// One byte changed anywhere in a real header — its parent's hash, its state root, its
    /// extra data — and its hash is no longer the block's.
    function test_aTamperedHeaderIsWrongBlockHash() public {
        Fixture memory f = load(NEAR);
        uint256[3] memory offsets = [uint256(10), 120, f.header.length - 1];
        for (uint256 i; i < offsets.length; i++) {
            bytes memory tampered = flipped(f.header, offsets[i], 0x01);
            vm.expectRevert(
                abi.encodeWithSelector(SpxHolderRegistry.WrongBlockHash.selector, keccak256(tampered), f.blockHash)
            );
            registry.prove(HOLDER, tampered, f.accountProof, f.storageProof);
        }
    }

    /// The attack a header check exists for: a real header given another block's state
    /// root, so that proofs against that root would be read as this block's. Its hash
    /// gives it away.
    function test_aHeaderCarryingAnotherStateRootIsWrongBlockHash() public {
        Fixture memory near = load(NEAR);
        Fixture memory far = load(FAR);
        bytes memory swapped = withField(near.header, 3, rlpString(abi.encodePacked(far.stateRoot)));
        vm.expectRevert(
            abi.encodeWithSelector(SpxHolderRegistry.WrongBlockHash.selector, keccak256(swapped), near.blockHash)
        );
        registry.prove(HOLDER, swapped, far.accountProof, far.storageProof);
    }

    /// A real header that lies about its number names a block whose hash it then fails to
    /// match: an old block's header claiming to be a recent one.
    function test_aHeaderThatLiesAboutItsNumberIsWrongBlockHash() public {
        Fixture memory near = load(NEAR);
        Fixture memory far = load(FAR);
        bytes memory renumbered = withField(far.header, 8, rlpString(bigEndian(near.blockNumber)));
        vm.expectRevert(
            abi.encodeWithSelector(SpxHolderRegistry.WrongBlockHash.selector, keccak256(renumbered), near.blockHash)
        );
        registry.prove(HOLDER, renumbered, far.accountProof, far.storageProof);
    }

    /// The current block's hash is not known while it is being built: the pinned block's
    /// true proof, on a fork of the pinned block, is `UnknownBlock`.
    function test_theCurrentBlockIsUnknown() public {
        Fixture memory f = load(PINNED);
        assertEq(f.blockNumber, block.number, "the current block");
        vm.expectRevert(abi.encodeWithSelector(SpxHolderRegistry.UnknownBlock.selector, f.blockNumber));
        prove(f);
    }

    /// Nor is a future block's: with the chain one block short of the pinned block, its
    /// header is from the future.
    function test_aFutureBlockIsUnknown() public {
        vm.roll(FORK_BLOCK - 1);
        Fixture memory f = load(PINNED);
        vm.expectRevert(abi.encodeWithSelector(SpxHolderRegistry.UnknownBlock.selector, f.blockNumber));
        prove(f);
    }

    /// A block more than 8,191 back is `UnknownBlock`: the recorded one 8,192 back, and a
    /// proof that was 100 blocks young once the chain has moved 8,192 past it.
    function test_aBlockMoreThan8191BackIsUnknown() public {
        Fixture memory tooOld = load(TOO_OLD);
        vm.expectRevert(abi.encodeWithSelector(SpxHolderRegistry.UnknownBlock.selector, tooOld.blockNumber));
        prove(tooOld);

        Fixture memory near = load(NEAR);
        vm.roll(near.blockNumber + 8192);
        vm.expectRevert(abi.encodeWithSelector(SpxHolderRegistry.UnknownBlock.selector, near.blockNumber));
        prove(near);
    }

    /// A header that is not an RLP list at all is `BadHeader`: nothing, an empty string, a
    /// 32-byte string, and the real header with its list prefix made a string prefix.
    function test_aHeaderThatIsNotAnRlpListIsBadHeader() public {
        Fixture memory f = load(NEAR);
        bytes[4] memory headers = [bytes(""), hex"80", rlpString(abi.encodePacked(f.blockHash)), copy(f.header)];
        headers[3][0] = 0xb9;
        for (uint256 i; i < headers.length; i++) {
            vm.expectRevert(abi.encodeWithSelector(SpxHolderRegistry.BadHeader.selector));
            registry.prove(HOLDER, headers[i], f.accountProof, f.storageProof);
        }
    }

    /// A list that stops before the timestamp is `BadHeader`: the real header's first 11
    /// fields (re-encoding all 21 gives back the real header, so the encoder is right), and
    /// an empty list.
    function test_aHeaderWithTooFewFieldsIsBadHeader() public {
        Fixture memory f = load(NEAR);
        bytes[] memory fields = fieldsOf(f.header);
        assertEq(listOf(fields, fields.length), f.header, "all 21 fields re-encoded: the real header");
        vm.expectRevert(abi.encodeWithSelector(SpxHolderRegistry.BadHeader.selector));
        registry.prove(HOLDER, listOf(fields, 11), f.accountProof, f.storageProof);
        vm.expectRevert(abi.encodeWithSelector(SpxHolderRegistry.BadHeader.selector));
        registry.prove(HOLDER, hex"c0", f.accountProof, f.storageProof);
    }

    /// Fields of the wrong width are `BadHeader`, before any hash is looked up: a number or
    /// a timestamp of 9 bytes (the same value behind a zero byte), and a state root of 31.
    function test_aHeaderFieldOfTheWrongWidthIsBadHeader() public {
        Fixture memory f = load(NEAR);
        bytes memory wideNumber = withField(f.header, 8, rlpString(widened(f.blockNumber, 9)));
        bytes memory wideTime = withField(f.header, 11, rlpString(widened(f.timestamp, 9)));
        bytes memory shortRoot = withField(f.header, 3, rlpString(bytes.concat(bytes31(f.stateRoot))));
        assertEq(RLPReader.readBytes(RLPReader.readList(wideNumber)[8]).length, 9, "a 9-byte number");
        assertEq(RLPReader.readBytes(RLPReader.readList(wideTime)[11]).length, 9, "a 9-byte timestamp");
        bytes[3] memory headers = [wideNumber, wideTime, shortRoot];
        for (uint256 i; i < headers.length; i++) {
            vm.expectRevert(abi.encodeWithSelector(SpxHolderRegistry.BadHeader.selector));
            registry.prove(HOLDER, headers[i], f.accountProof, f.storageProof);
        }
    }

    /// One holder's true proof submitted for another holder: the balance key is the named
    /// holder's, so the storage proof leads nowhere, whoever is named.
    function test_aProofOfOneHolderSubmittedForAnotherReverts() public {
        Fixture memory f = load(NEAR);
        address[3] memory others = [SELLER, SHORT, makeAddr("spdex.vault.test/nobody")];
        for (uint256 i; i < others.length; i++) {
            vm.expectRevert();
            registry.prove(others[i], f.header, f.accountProof, f.storageProof);
        }
        assertEq(registry.validUntil(SELLER), 0, "nobody recorded");
    }

    /// One byte changed in any node of the account proof, at its start, its middle or its
    /// end, and the proof no longer leads from the state root to SPX.
    function test_aChangedByteInAnyAccountProofNodeReverts() public {
        Fixture memory f = load(NEAR);
        for (uint256 i; i < f.accountProof.length; i++) {
            uint256[3] memory offsets = [uint256(0), f.accountProof[i].length / 2, f.accountProof[i].length - 1];
            for (uint256 j; j < offsets.length; j++) {
                bytes[] memory proof = copy(f.accountProof);
                proof[i] = flipped(proof[i], offsets[j], 0x01);
                vm.expectRevert();
                registry.prove(HOLDER, f.header, proof, f.storageProof);
            }
        }
    }

    /// The same for every node of the storage proof.
    function test_aChangedByteInAnyStorageProofNodeReverts() public {
        Fixture memory f = load(NEAR);
        for (uint256 i; i < f.storageProof.length; i++) {
            uint256[3] memory offsets = [uint256(0), f.storageProof[i].length / 2, f.storageProof[i].length - 1];
            for (uint256 j; j < offsets.length; j++) {
                bytes[] memory proof = copy(f.storageProof);
                proof[i] = flipped(proof[i], offsets[j], 0x80);
                vm.expectRevert();
                registry.prove(HOLDER, f.header, f.accountProof, proof);
            }
        }
    }

    /// A storage proof spliced in from another holder at the same block, under the same
    /// storage root: true of that holder, and leading nowhere for this one, either way
    /// round. Both proofs are sound on their own, which the last line shows.
    function test_aStorageProofSplicedFromAnotherHolderReverts() public {
        Fixture memory mine = load(FAR);
        Fixture memory theirs = load(SOLD);
        assertEq(mine.blockNumber, theirs.blockNumber, "the same block");
        assertEq(keccak256(mine.storageProof[0]), keccak256(theirs.storageProof[0]), "the same storage root");
        vm.expectRevert();
        registry.prove(HOLDER, mine.header, mine.accountProof, theirs.storageProof);
        vm.expectRevert();
        registry.prove(SELLER, theirs.header, theirs.accountProof, mine.storageProof);
        assertTrue(proves(HOLDER, mine.header, mine.accountProof, mine.storageProof), "each proves its own holder");
        assertTrue(proves(SELLER, theirs.header, theirs.accountProof, theirs.storageProof), "both of them");
    }

    /// An account proof from another block does not start at this header's state root.
    function test_anAccountProofFromAnotherBlockReverts() public {
        Fixture memory near = load(NEAR);
        Fixture memory far = load(FAR);
        vm.expectRevert();
        registry.prove(HOLDER, near.header, far.accountProof, far.storageProof);
        vm.expectRevert();
        registry.prove(HOLDER, near.header, far.accountProof, near.storageProof);
    }

    /// A true proof of less than the minimum is `BelowMinimum`, with the balance and the
    /// minimum: 213 SPX.
    function test_aTrueProofBelowTheMinimumIsBelowMinimumWithTheFigures() public {
        Fixture memory f = load(BELOW);
        assertEq(f.balance, 21_300_000_000, "213 SPX");
        vm.expectRevert(abi.encodeWithSelector(SpxHolderRegistry.BelowMinimum.selector, f.balance, MIN_SPX));
        prove(f);
    }

    /// A holder with no SPX has no balance in SPX's storage trie at all, and a proof of
    /// absence proves nothing: the verifier itself refuses it.
    function test_aHolderWithNoSpxCannotProve() public {
        Fixture memory f = load(ABSENT);
        assertEq(f.balance, 0, "no SPX");
        (bool ok, bytes memory reason) =
            address(registry).call(proveCall(SELLER, f.header, f.accountProof, f.storageProof));
        assertTrue(!ok, "refused");
        assertEq(bytes4(reason), bytes4(keccak256("Error(string)")), "by the verifier, with its message");
        bytes memory message = bytes(abi.decode(withoutSelector(reason), (string)));
        bytes memory from = "MerkleTrie: ";
        assertEq(prefix(message, from.length), from, "the verifier's own refusal");
    }

    /// Nothing here takes ether: `prove` refuses it, and so does the contract itself.
    function test_theRegistryTakesNoEther() public {
        Fixture memory f = load(NEAR);
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(registry).call{value: 1}(proveCall(HOLDER, f.header, f.accountProof, f.storageProof));
        assertTrue(!ok, "prove refuses ether");
        (ok,) = address(registry).call{value: 1}("");
        assertTrue(!ok, "a plain transfer is refused");
        assertEq(address(registry).balance, 0, "it holds none");
    }

    // ─── What the code can do at all ─────────────────────────────────────────────

    /// The runtime code, read opcode by opcode: one SSTORE (the `validUntil` it records),
    /// no CALL of any kind but STATICCALL (it moves nothing and changes nothing elsewhere),
    /// and no SELFDESTRUCT, DELEGATECALL, CALLCODE, CREATE or CREATE2. There is nothing an
    /// owner could hold, because there is no code that could act for one.
    function test_theRegistryCanWriteOnlyValidUntilAndCallOnlyToRead() public view {
        bytes memory code = address(registry).code;
        assertEq(opcodes(code, 0x55), 1, "one SSTORE");
        assertEq(opcodes(code, 0x5d), 0, "no TSTORE");
        assertEq(opcodes(code, 0xf1), 0, "no CALL");
        assertEq(opcodes(code, 0xfa), 2, "two STATICCALLs: the history contract and SPX");
        uint8[5] memory banned = [0xff, 0xf4, 0xf2, 0xf0, 0xf5];
        for (uint256 i; i < banned.length; i++) {
            assertEq(opcodes(code, banned[i]), 0, "no SELFDESTRUCT/DELEGATECALL/CALLCODE/CREATE/CREATE2");
        }
    }

    /// The agreed constants, and SPX's balance slot checked against SPX itself: for three
    /// holders, the slot the registry proves holds exactly what `balanceOf` answers.
    function test_theConstantsAreTheAgreedOnesAndTheSlotIsSpxsBalance() public view {
        assertEq(registry.SPX(), SPX, "SPX");
        assertEq(registry.HISTORY(), HISTORY, "EIP-2935's history contract");
        assertEq(registry.MIN_SPX(), 690e8, "690 SPX at 8 decimals");
        assertEq(registry.PROOF_TTL(), 30 days, "30 days");
        assertEq(registry.HISTORY_BLOCKS(), 8191, "EIP-2935's window");
        assertEq(registry.BALANCE_SLOT(), 1, "slot 1");
        address[3] memory holders = [HOLDER, SELLER, SHORT];
        for (uint256 i; i < holders.length; i++) {
            bytes32 slot = keccak256(abi.encode(holders[i], registry.BALANCE_SLOT()));
            assertEq(uint256(vmr.load(SPX, slot)), spxOf(holders[i]), "the slot is the balance");
            assertGt(spxOf(holders[i]), 0, "of a holder with some");
        }
    }

    /// `validUntil` is the registry's only storage, mapping slot 0: a holder's record is at
    /// `keccak256(abi.encode(holder, 0))`, as a uint64 in the slot's low bytes. The fork
    /// tests of the app make a fresh key eligible by writing exactly that slot
    /// (`anvil_setStorageAt`), since a local fork cannot prove its own blocks, so the
    /// layout is pinned here: a record written there is read back, and makes its address
    /// eligible like a proof.
    function test_validUntilIsMappingSlotZero() public {
        uint64 until = prove(load(NEAR));
        bytes32 slot = keccak256(abi.encode(HOLDER, uint256(0)));
        assertEq(uint256(vmr.load(address(registry), slot)), until, "the holder's record, at slot 0's key");

        address fresh = makeAddr("spdex.vault.test/written");
        vm.store(
            address(registry), keccak256(abi.encode(fresh, uint256(0))), bytes32(uint256(block.timestamp + 1 days))
        );
        assertEq(registry.validUntil(fresh), block.timestamp + 1 days, "a written record reads back");
        assertTrue(!registry.isEligible(fresh), "without SPX, still not eligible");
        vm.prank(HOLDER);
        IERC20Registry(SPX).transfer(fresh, MIN_SPX);
        assertTrue(registry.isEligible(fresh), "with 690 SPX, eligible like a proof");
    }

    // ─── Fuzzing ─────────────────────────────────────────────────────────────────

    /// Any bytes at all in place of the header, with real proofs beside them: never proven.
    function testFuzz_randomHeaderBytesNeverProve(bytes memory junk) public {
        Fixture memory f = load(NEAR);
        vm.expectRevert();
        registry.prove(HOLDER, junk, f.accountProof, f.storageProof);
    }

    /// Any one byte of the real header changed, any way: never proven.
    function testFuzz_aChangedHeaderByteNeverProves(uint256 offset, uint8 mask) public {
        Fixture memory f = load(NEAR);
        bytes memory header = flipped(f.header, offset % f.header.length, mask == 0 ? 1 : mask);
        vm.expectRevert();
        registry.prove(HOLDER, header, f.accountProof, f.storageProof);
    }

    /// Any one byte of any node of either proof changed, any way: never proven.
    function testFuzz_aChangedByteInAnyProofNodeNeverProves(bool inStorage, uint256 node, uint256 offset, uint8 mask)
        public
    {
        Fixture memory f = load(NEAR);
        bytes[] memory proof = copy(inStorage ? f.storageProof : f.accountProof);
        uint256 i = node % proof.length;
        proof[i] = flipped(proof[i], offset % proof[i].length, mask == 0 ? 1 : mask);
        vm.expectRevert();
        if (inStorage) registry.prove(HOLDER, f.header, f.accountProof, proof);
        else registry.prove(HOLDER, f.header, proof, f.storageProof);
    }

    /// Cut short anywhere — the header's bytes, either proof's list of nodes, or the bytes
    /// of any one node — or given a node too many: never proven.
    function testFuzz_aTruncatedOrExtendedProofNeverProves(uint8 what, uint256 cut, uint256 node) public {
        Fixture memory f = load(NEAR);
        bytes memory header = f.header;
        bytes[] memory accountProof = f.accountProof;
        bytes[] memory storageProof = f.storageProof;
        uint256 kind = what % 5;
        if (kind == 0) {
            header = prefix(f.header, cut % f.header.length);
        } else if (kind == 1) {
            accountProof = firstNodes(f.accountProof, cut % f.accountProof.length);
        } else if (kind == 2) {
            storageProof = firstNodes(f.storageProof, cut % f.storageProof.length);
        } else if (kind == 3) {
            bool inStorage = cut % 2 == 0;
            bytes[] memory proof = copy(inStorage ? f.storageProof : f.accountProof);
            uint256 i = node % proof.length;
            proof[i] = prefix(proof[i], (cut / 2) % proof[i].length);
            if (inStorage) storageProof = proof;
            else accountProof = proof;
        } else {
            bool inStorage = cut % 2 == 0;
            bytes[] memory proof = inStorage ? f.storageProof : f.accountProof;
            bytes[] memory longer = new bytes[](proof.length + 1);
            for (uint256 i; i < proof.length; i++) {
                longer[i] = proof[i];
            }
            longer[proof.length] = proof[node % proof.length];
            if (inStorage) storageProof = longer;
            else accountProof = longer;
        }
        vm.expectRevert();
        registry.prove(HOLDER, header, accountProof, storageProof);
    }

    // ─── Gas ─────────────────────────────────────────────────────────────────────

    /// `prove` for every recorded eligible proof, as a first proof from cold (the registry,
    /// its slot and the history contract cooled): the call's own gas within `PROVE_GAS`,
    /// and what the whole transaction would cost with its 8 KB of calldata, logged.
    function test_proveFitsItsBudgetThroughEitherPath() public {
        string[7] memory names = eligibleFixtures();
        uint256 most;
        for (uint256 i; i < names.length; i++) {
            Fixture memory f = load(names[i]);
            bytes memory data = proveCall(f.holder, f.header, f.accountProof, f.storageProof);
            uint256 snapshot = vmr.snapshotState();
            vmr.cool(address(registry));
            vmr.cool(HISTORY);
            (bool ok,) = address(registry).call(data);
            assertTrue(ok, "proven");
            uint256 used = vmr.lastCallGas().gasTotalUsed;
            vmr.revertToState(snapshot);
            console.log(names[i], used);
            console.log("  as a transaction", transactionGas(data, used));
            console.log("  calldata bytes", data.length);
            assertLt(used, PROVE_GAS, "prove within its budget");
            if (used > most) most = used;
        }
        console.log("prove: the most any recorded proof used", most);

        // A deeper storage proof (7 nodes, against 6 above), to the refusal that follows
        // the verification: all of a success's work but the record and the event.
        vm.roll(FORK_BLOCK + 1);
        Fixture memory deep = load(SHORTFALL);
        assertEq(deep.storageProof.length, 7, "seven storage nodes");
        vmr.cool(address(registry));
        (bool refused,) =
            address(registry).call(proveCall(deep.holder, deep.header, deep.accountProof, deep.storageProof));
        assertTrue(!refused, "BelowMinimum");
        console.log("a 7-node storage proof, up to its BelowMinimum", vmr.lastCallGas().gasTotalUsed);
    }

    /// `isEligible` from cold, as a vault's first check in a transaction finds it, uses less
    /// than an eighth of the vault's 100,000 stipend — room for a fork that reprices cold reads
    /// several times over — and gives the right answer within it;
    /// warm, it costs less. Cold means the registry, SPX and the holder's own account, whose
    /// code is read. Logged: cold and warm, for an eligible address, one that has delegated
    /// (EIP-7702: its 23 bytes of code are read too) and one that never proved, and the least
    /// gas the cold eligible check needs.
    ///
    /// The delegated figure is worked out rather than read: forge keeps an account it has
    /// etched warm, whatever `cool` says, so on the etched holder both shapes are measured
    /// warm, and what reading the designator adds is the difference, on top of the plain cold
    /// figure.
    function test_isEligibleFitsTheVaultsStipendColdAndWarm() public {
        prove(load(NEAR));
        bytes memory data = abi.encodeCall(SpxHolderRegistry.isEligible, (HOLDER));

        uint256 snapshot = vmr.snapshotState();
        coolAll();
        (bool ok, bytes memory answer) = address(registry).staticcall{gas: ELIGIBILITY_GAS}(data);
        assertTrue(ok && abi.decode(answer, (bool)), "eligible, within the stipend, from cold");
        uint256 cold = vmr.lastCallGas().gasTotalUsed;
        (ok, answer) = address(registry).staticcall{gas: ELIGIBILITY_GAS}(data);
        assertTrue(ok && abi.decode(answer, (bool)), "and again, warm");
        uint256 warm = vmr.lastCallGas().gasTotalUsed;
        vmr.revertToState(snapshot);
        uint256 least = leastGasForEligible(data);

        coolAll();
        (ok, answer) =
            address(registry).staticcall{gas: ELIGIBILITY_GAS}(abi.encodeCall(SpxHolderRegistry.isEligible, (SELLER)));
        assertTrue(ok && !abi.decode(answer, (bool)), "never proved: not eligible");
        uint256 neverProved = vmr.lastCallGas().gasTotalUsed;

        vmr.etch(HOLDER, "");
        uint256 plainEtched = eligibleGas(data);
        vmr.etch(HOLDER, abi.encodePacked(hex"ef0100", address(registry)));
        uint256 delegatedEtched = eligibleGas(data);
        vmr.etch(HOLDER, "");
        uint256 delegated = cold + (delegatedEtched - plainEtched);

        console.log("isEligible, eligible, cold", cold);
        console.log("isEligible, eligible, warm", warm);
        console.log("isEligible, eligible and delegated, cold", delegated);
        console.log("isEligible, never proved, cold", neverProved);
        console.log("isEligible, eligible, cold: least gas that answers true", least);
        assertLt(cold * 8, ELIGIBILITY_GAS, "cold: under an eighth of the stipend");
        assertLt(delegated * 8, ELIGIBILITY_GAS, "delegated, cold: under an eighth of the stipend");
        assertLt(warm, cold, "warm: less");
        assertLt(least * 8, ELIGIBILITY_GAS, "the least that answers: under an eighth of the stipend");
    }

    /// What one `isEligible` that answers `true` uses, everything cooled first; undone.
    function eligibleGas(bytes memory data) internal returns (uint256 used) {
        uint256 snapshot = vmr.snapshotState();
        coolAll();
        (bool ok, bytes memory answer) = address(registry).staticcall{gas: ELIGIBILITY_GAS}(data);
        assertTrue(ok && abi.decode(answer, (bool)), "eligible, within the stipend");
        used = vmr.lastCallGas().gasTotalUsed;
        vmr.revertToState(snapshot);
    }

    /// The registry, SPX and the holders' own accounts cold, as at the start of a transaction.
    function coolAll() internal {
        vmr.cool(address(registry));
        vmr.cool(SPX);
        vmr.cool(HOLDER);
        vmr.cool(SELLER);
    }

    /// The least gas a cold `isEligible` answers `true` with, found by bisection on copies
    /// of this moment.
    function leastGasForEligible(bytes memory data) internal returns (uint256) {
        uint256 low = 1_000;
        uint256 high = ELIGIBILITY_GAS;
        while (low < high) {
            uint256 middle = (low + high) / 2;
            uint256 snapshot = vmr.snapshotState();
            coolAll();
            (bool ok, bytes memory answer) = address(registry).staticcall{gas: middle}(data);
            vmr.revertToState(snapshot);
            if (ok && answer.length == 32 && abi.decode(answer, (bool))) high = middle;
            else low = middle + 1;
        }
        return low;
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────────

    function assertProven(VmLog[] memory logs, Fixture memory f, uint64 until) internal view {
        uint256 n;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter != address(registry) || logs[i].topics[0] != PROVEN_TOPIC) continue;
            n++;
            assertEq(logs[i].topics[1], bytes32(uint256(uint160(f.holder))), "Proven names the holder");
            assertEq(uint256(logs[i].topics[2]), f.blockNumber, "and the block");
            (uint256 balance, uint64 validUntil) = abi.decode(logs[i].data, (uint256, uint64));
            assertEq(balance, f.balance, "and the proven balance");
            assertEq(validUntil, until, "and validUntil");
        }
        assertEq(n, 1, "one Proven");
    }

    /// A transaction's gas with this calldata and this much execution: the larger of the
    /// standard price and EIP-7623's floor for calldata-heavy transactions.
    function transactionGas(bytes memory data, uint256 execution) internal pure returns (uint256) {
        uint256 zeros;
        for (uint256 i; i < data.length; i++) {
            if (data[i] == 0) zeros++;
        }
        uint256 nonZeros = data.length - zeros;
        uint256 standard = 21_000 + zeros * 4 + nonZeros * 16 + execution;
        uint256 floor = 21_000 + 10 * (zeros + 4 * nonZeros);
        return standard > floor ? standard : floor;
    }

    /// How many times `op` occurs as an opcode in `code`, skipping PUSH data.
    function opcodes(bytes memory code, uint8 op) internal pure returns (uint256 n) {
        for (uint256 i; i < code.length;) {
            uint8 o = uint8(code[i]);
            if (o == op) n++;
            i += (o >= 0x60 && o <= 0x7f) ? uint256(o) - 0x5e : 1;
        }
    }

    function prefix(bytes memory data, uint256 length) internal pure returns (bytes memory out) {
        out = new bytes(length);
        for (uint256 i; i < length; i++) {
            out[i] = data[i];
        }
    }

    function firstNodes(bytes[] memory proof, uint256 n) internal pure returns (bytes[] memory out) {
        out = new bytes[](n);
        for (uint256 i; i < n; i++) {
            out[i] = proof[i];
        }
    }

    function withoutSelector(bytes memory data) internal pure returns (bytes memory rest) {
        rest = new bytes(data.length - 4);
        for (uint256 i; i < rest.length; i++) {
            rest[i] = data[i + 4];
        }
    }
}
