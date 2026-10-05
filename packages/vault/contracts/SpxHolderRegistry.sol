// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.33;

import {ISpxHolderRegistry} from "./interfaces/ISpxHolderRegistry.sol";
import {RLPReader} from "./vendor/optimism/rlp/RLPReader.sol";
import {SecureMerkleTrie} from "./vendor/optimism/trie/SecureMerkleTrie.sol";

/// SPX's one function the registry calls.
interface ISpxBalance {
    function balanceOf(address account) external view returns (uint256);
}

/// @title SpxHolderRegistry — who may be paid a v2 vault's fee inside its community window
/// @author spDEX
/// @notice UNAUDITED. No owner, no admin, no upgrade, no fee, and it never holds or moves
///         anyone's tokens or ether: its only storage is one timestamp per address that has
///         proven. It decides one thing, which a v2 vault asks during a buy's community
///         window: may this `rewardTo` be paid the buy's fee? It never touches a vault's
///         funds, and a vault treats any failure of this contract as "no", so the worst a
///         bug here can do is pay a window's fee to someone who should have waited, or
///         make a buy wait out its window (`docs/V2_UPGRADE.md`, "Risks").
///
/// ## What it proves
///
/// An address is eligible while three things are true:
///
/// 1. It held at least `MIN_SPX` (690 SPX) when some block closed, and that block's time is
///    at most `PROOF_TTL` (30 days) ago: inclusive, through the second `validUntil` names.
///    `prove` checks this once, from Ethereum's own state: a block header whose hash is the
///    block's real hash, a Merkle-Patricia proof from that header's state root to SPX's
///    account, and a second from SPX's storage root to the holder's balance. No list is kept
///    and nothing is deposited or locked; the SPX stays in the holder's wallet, and checks
///    cost the same for ten holders or fifty thousand.
/// 2. It holds at least `MIN_SPX` now. `isEligible` reads SPX's `balanceOf` at the moment
///    of the buy.
/// 3. It is an account, not a contract: it has no code, or only an EIP-7702 delegation
///    designator, which nobody but the account's own key can put there. Checked at the
///    moment of the buy too, because code can arrive at an address after it proved.
///
/// The third is there because a contract can hand what it is paid to whoever asks. Uniswap
/// v2's SPX/WETH pair held 13 million SPX at the pinned block, and a true proof of it is as
/// easy to send as anyone's; a fee paid to the pair sits above its reserves, and its `skim`
/// gives that to any caller in the same transaction. Were contracts eligible, a bot with no
/// SPX, no proof of its own and no loan could name the pair (or v4's `PoolManager`, or any
/// contract that pays out what it is sent) and take every window's fee
/// (`test_aProvenContractThatHandsOutWhatItIsPaidIsNeverEligible`). An account's fee is its
/// key-holder's, and its 690 SPX theirs. The cost is that SPX held in a contract wallet (a
/// Safe, a smart account) cannot be a `rewardTo`: such a holder names an ordinary account
/// holding 690 SPX of its own instead.
///
/// A proof states a fact about the chain, so anyone may submit anyone's: a hot browser
/// wallet can pay the gas to prove a keeper's cold `rewardTo` without the cold wallet ever
/// touching a browser. `msg.sender` appears nowhere in `prove`.
///
/// ## How a header is trusted
///
/// The header is hashed exactly as given, and that hash must equal the block's real hash,
/// which this contract reads from the chain itself and never takes from the caller:
///
/// - `BLOCKHASH` for the last 256 blocks, as every EVM has always offered;
/// - EIP-2935's history contract (`HISTORY`, live on mainnet since Prague) for the 8,191
///   before the current one, about 27 hours.
///
/// The app and the keeper prove the `finalized` block, about 13 minutes old. No reorg can
/// change its hash, so a proof never fails for that reason, and EIP-2935's reach lets a
/// built proof wait unsigned in a tab for hours. `BLOCKHASH` alone reaches back 256 blocks,
/// about 51 minutes, which would leave a proof of the `finalized` block about half an hour
/// to land. It stays because it is what keeps proving possible if a future hard fork moves
/// or retires EIP-2935: the `finalized` block is inside its 256.
///
/// Once the hash matches, every byte of the header is the chain's, so the three fields read
/// from it (3, the state root; 8, the number; 11, the timestamp) are too. Those positions
/// have not moved since Frontier, and forks only ever append fields, so a header with more
/// fields than today's 21 proves the same way, up to the vendored reader's limit of 32
/// fields to a list. The number is read before the hash is known, to know which hash to
/// ask for; a header that lies about its number names a block whose hash it then fails to
/// match.
///
/// ## The proof verifier, and where review starts
///
/// Following a Merkle-Patricia proof is the one complex piece of v2, so it is not written
/// here. `SecureMerkleTrie`, `MerkleTrie`, `RLPReader` and `Bytes` are Optimism's
/// (MIT, `op-contracts/v8.0.0`), vendored under `vendor/optimism` byte for byte except for
/// their import paths; its README names the commit and each file's hash. Optimism's portal
/// proves every withdrawal from its chain with the same library. A bad proof reverts inside
/// it, with its own messages; this contract adds nothing to its verdict but the two value
/// shapes it expects (an account, and a balance of at most 32 bytes).
///
/// A key that is not in the trie has no inclusion proof, and the verifier refuses a proof
/// of absence: an address that never held SPX, or holds none now, simply cannot prove.
///
/// ## What it costs
///
/// Measured on the fork at the pinned block (`test/forge/Registry.t.sol`): `prove` about
/// 520,000 to 550,000 gas as a call, and about 660,000 as a transaction with its 8 KB of
/// calldata, once every 30 days. Nearly all of it is the vendored reader decoding each node
/// of the two proofs (about 25,000 gas for each 17-item branch node), the price of not
/// writing a verifier fresh. `isEligible` costs about 11,200 gas from cold (11,700 for an
/// account that has delegated, whose 23 bytes of code are read) and 2,200 warm, against
/// the vault's 30,000 stipend, and the same for ten holders or fifty thousand.
///
/// ## What a flash loan can and cannot do
///
/// A proof reads a block's final state, and a flash loan is borrowed and repaid inside one
/// transaction, so it never appears there: to prove, an address must really have held
/// `MIN_SPX` when a block closed. The balance check at the moment of the buy is different:
/// a flash borrow meets it, one borrow can wrap a whole batch, and Uniswap v4's
/// `PoolManager` lends within a transaction for no fee. So an address can buy 690 SPX, hold
/// it past one block's end, prove, sell it back for about the cost of a round trip, and
/// then meet the balance check with borrowed SPX for `PROOF_TTL`, paying only gas. What this
/// contract really filters for is "held `MIN_SPX` at a block's end in the last 30 days", and
/// the docs say exactly that. The balance check stays anyway: it costs a few thousand gas,
/// and it stops a holder who sold, or a bag moved from address to address and proven for
/// each, from earning, unless they write a contract for the purpose. Nothing on chain can
/// tell borrowed SPX from held SPX inside a transaction; this contract does not pretend to.
///
/// ## What proving makes public
///
/// A `Proven` event says, forever, that an address held at least 690 SPX at a block. Since
/// anyone may prove any address, it says nothing about whether that address runs a keeper. A
/// keeper's buys do: each puts its `rewardTo` in calldata beside the key that sent it,
/// linking the two in public. The app says so before a wallet's first proof, and
/// `docs/KEEPER.md` suggests a wallet kept for the SPX rather than a main one.
///
/// ## What it deliberately does not do
///
/// - **No owner, no admin, no setter, no upgrade.** `MIN_SPX`, `PROOF_TTL`, SPX's address
///   and its balance slot are constants. Changing any of them means a new registry, and a
///   new factory and vault implementation that name it: a new release.
/// - **No ether.** Nothing here is payable, so a mistaken transfer reverts rather than
///   sticking.
/// - **No list.** Nothing on chain enumerates holders; `Proven` events are the record.
/// - **No proof that would change nothing.** A proof whose block is not newer than the one
///   already recorded reverts with `NotNewer`, so a private relay drops it, as it drops a
///   batch that bought nothing, and nobody pays gas to change nothing.
contract SpxHolderRegistry is ISpxHolderRegistry {
    /// SPX6900: 8 decimals, 1,000,000,000 supply. A plain contract, not a proxy (checked
    /// 2026-10-02), so its storage layout is fixed.
    address public constant SPX = 0xE0f63A424a4439cBE457D80E4f4b51aD25b2c56C;
    /// EIP-2935's block hash history contract: `get(number)` answers the hash of any of the
    /// 8,191 blocks before the current one, and reverts for any other.
    address public constant HISTORY = 0x0000F90827F1C53a10cb7A02335B175320002935;
    /// SPX keeps balances in mapping slot 1: a holder's balance is at
    /// `keccak256(abi.encode(holder, 1))` (checked against two holders' `balanceOf`, and
    /// against every recorded fixture by `scripts/record-proofs.mjs`).
    uint256 public constant BALANCE_SLOT = 1;
    /// 690 SPX, in SPX's 8 decimals: the holding that makes an address eligible, proven at a
    /// block's end and held at the moment of each buy. Within reach of ordinary holders;
    /// a bot can carry it too (`docs/V2_UPGRADE.md`, decision 1).
    uint256 public constant MIN_SPX = 69_000_000_000;
    /// How long a proof lasts, counted from the proven block's own time, not from when it
    /// was sent: one proof a month per keeper (about 660,000 gas, 0.00007 ETH at 0.1 gwei),
    /// and a holder who sells drops out at once anyway, at the balance check.
    uint256 public constant PROOF_TTL = 30 days;
    /// How far back a proven block may be: EIP-2935's window, in blocks.
    uint256 public constant HISTORY_BLOCKS = 8191;
    /// How far back `BLOCKHASH` answers.
    uint256 private constant BLOCKHASH_BLOCKS = 256;
    /// An EIP-7702 delegation designator, the only code an account can carry: these three
    /// bytes and the delegate's 20-byte address, 23 bytes in all. Nothing else on chain can
    /// begin with 0xef (EIP-3541 refuses it at deployment).
    bytes3 private constant DELEGATION_PREFIX = 0xef0100;
    uint256 private constant DELEGATION_LENGTH = 23;

    /// The header's fields this contract reads, by position. Unchanged since Frontier.
    uint256 private constant STATE_ROOT_FIELD = 3;
    uint256 private constant NUMBER_FIELD = 8;
    uint256 private constant TIMESTAMP_FIELD = 11;
    /// An account in the state trie: [nonce, balance, storageRoot, codeHash].
    uint256 private constant ACCOUNT_FIELDS = 4;
    uint256 private constant STORAGE_ROOT_FIELD = 2;

    /// When each address's latest proof lapses (chain time, inclusive); 0 if it never proved.
    /// The only storage: mapping slot 0, so a holder's record is at
    /// `keccak256(abi.encode(holder, 0))`. The fork tests rely on that layout to make a fresh
    /// key eligible, since a local fork cannot prove a block it mined.
    mapping(address holder => uint64) public validUntil;

    /// `prove` was given the zero address, which can never be paid.
    error ZeroHolder();
    /// The header is not an RLP list of at least 12 fields, or its state root is not 32
    /// bytes, or its number or timestamp is wider than 8 bytes. (RLP that is malformed in
    /// itself is refused by the vendored reader, with its own errors.)
    error BadHeader();
    /// The header's block is not one whose hash this contract can read: the current block,
    /// a future one, or one more than `HISTORY_BLOCKS` back — or its hash came back zero.
    error UnknownBlock(uint256 number);
    /// The header does not hash to the real hash of the block it names.
    error WrongBlockHash(bytes32 given, bytes32 actual);
    /// The proof is true, and shows less than `MIN_SPX`.
    error BelowMinimum(uint256 balance, uint256 minimum);
    /// The verifier returned a value that is not an account, or a balance wider than 32
    /// bytes. A value proven from a real state root never is: this is a guard on the
    /// verifier, not a refusal anyone should meet.
    error BadProofValue();

    /// @notice Record that `holder` held at least `MIN_SPX` at the end of the block `header`
    ///         describes, one of the last `HISTORY_BLOCKS`. Anyone may send anyone's proof.
    /// @param header The block's header, RLP-encoded exactly as the protocol hashes it.
    /// @param accountProof `eth_getProof(SPX, [key], block).accountProof`: from the block's
    ///        state root to SPX's account.
    /// @param storageProof `eth_getProof(SPX, [key], block).storageProof[0].proof`, where
    ///        `key = keccak256(abi.encode(holder, BALANCE_SLOT))`: from SPX's storage root
    ///        to `holder`'s balance.
    /// @return newValidUntil The proven block's time plus `PROOF_TTL`, now recorded.
    function prove(address holder, bytes calldata header, bytes[] calldata accountProof, bytes[] calldata storageProof)
        external
        returns (uint64 newValidUntil)
    {
        if (holder == address(0)) revert ZeroHolder();

        (bytes32 stateRoot, uint256 number, uint256 timestamp) = _verifiedHeader(header);
        uint256 balance = _balance(_spxStorageRoot(stateRoot, accountProof), holder, storageProof);
        if (balance < MIN_SPX) revert BelowMinimum(balance, MIN_SPX);

        // `timestamp` is at most 8 bytes wide and the chain's own, so adding 30 days cannot
        // overflow 64 bits for another 584 billion years.
        // forge-lint: disable-next-line(unsafe-typecast) — a real block's time plus 30 days.
        newValidUntil = uint64(timestamp + PROOF_TTL);
        uint64 stored = validUntil[holder];
        if (newValidUntil <= stored) revert NotNewer(stored);
        validUntil[holder] = newValidUntil;
        emit Proven(holder, number, balance, newValidUntil);
    }

    /// @notice A proof is still valid (inclusive: through the second `validUntil` names),
    ///         `holder` is an account rather than a contract, and it has at least `MIN_SPX`
    ///         right now. A vault calls this with a fixed gas stipend and treats a revert, or
    ///         a run out of gas, as `false`.
    function isEligible(address holder) external view returns (bool) {
        // Cheapest first: an address that never proved costs one storage read, and neither
        // its code nor SPX is looked at.
        return
            block.timestamp <= validUntil[holder] && _isAccount(holder) && ISpxBalance(SPX).balanceOf(holder) >= MIN_SPX;
    }

    /// Whether `holder` is an account: no code at all, or exactly an EIP-7702 delegation
    /// designator. Any other code is a contract's, and a contract can pass on what it is paid
    /// to whoever asks it to (see "What it proves").
    function _isAccount(address holder) private view returns (bool) {
        uint256 size = holder.code.length;
        if (size == 0) return true;
        if (size != DELEGATION_LENGTH) return false;
        return bytes3(holder.code) == DELEGATION_PREFIX;
    }

    /// The header's state root, number and timestamp, once its hash is the real hash of the
    /// block it names.
    function _verifiedHeader(bytes calldata header)
        private
        view
        returns (bytes32 stateRoot, uint256 number, uint256 timestamp)
    {
        (stateRoot, number, timestamp) = _readHeader(header);
        bytes32 actual = _blockHash(number);
        bytes32 given = keccak256(header);
        if (given != actual) revert WrongBlockHash(given, actual);
    }

    /// The header's state root, number and timestamp. Nothing here is trusted yet:
    /// `_verifiedHeader` compares the header's hash with the real one before any of it is
    /// used.
    function _readHeader(bytes calldata header)
        private
        pure
        returns (bytes32 stateRoot, uint256 number, uint256 timestamp)
    {
        // An RLP list starts with a byte of 0xc0 or more. The vendored reader would refuse
        // anything else too, but with a message about strings; this one says what was wrong.
        if (header.length == 0 || uint8(header[0]) < 0xc0) revert BadHeader();
        RLPReader.RLPItem[] memory fields = RLPReader.readList(header);
        if (fields.length <= TIMESTAMP_FIELD) revert BadHeader();

        bytes memory root = RLPReader.readBytes(fields[STATE_ROOT_FIELD]);
        if (root.length != 32) revert BadHeader();
        // forge-lint: disable-next-line(unsafe-typecast) — exactly 32 bytes, checked above.
        stateRoot = bytes32(root);
        number = _uint64Field(fields[NUMBER_FIELD]);
        timestamp = _uint64Field(fields[TIMESTAMP_FIELD]);
    }

    /// A header integer: big-endian, at most 8 bytes, as the protocol bounds block numbers
    /// and timestamps.
    function _uint64Field(RLPReader.RLPItem memory item) private pure returns (uint256 value) {
        bytes memory raw = RLPReader.readBytes(item);
        if (raw.length > 8) revert BadHeader();
        for (uint256 i; i < raw.length; i++) {
            value = (value << 8) | uint8(raw[i]);
        }
    }

    /// The real hash of block `number`, from the chain: `BLOCKHASH` for the last 256 blocks,
    /// EIP-2935's history contract for the 8,191 before this one. Never from the caller.
    function _blockHash(uint256 number) private view returns (bytes32 hash) {
        if (number >= block.number) revert UnknownBlock(number);
        uint256 age = block.number - number;
        if (age <= BLOCKHASH_BLOCKS) {
            hash = blockhash(number);
        } else if (age <= HISTORY_BLOCKS) {
            // `get` takes the number as one 32-byte word and answers one 32-byte word, or
            // reverts for a block outside its window. Anything else — no code there after a
            // future fork, an answer of another size — leaves `hash` zero.
            (bool ok, bytes memory answer) = HISTORY.staticcall(abi.encode(number));
            // forge-lint: disable-next-line(unsafe-typecast) — exactly 32 bytes, checked first.
            if (ok && answer.length == 32) hash = bytes32(answer);
        }
        if (hash == bytes32(0)) revert UnknownBlock(number);
    }

    /// SPX's storage root at the proven block: the third field of its account, proven from
    /// the block's state root, where the account's key is the keccak256 of SPX's address.
    function _spxStorageRoot(bytes32 stateRoot, bytes[] calldata accountProof) private pure returns (bytes32) {
        bytes memory account = SecureMerkleTrie.get(abi.encodePacked(SPX), accountProof, stateRoot);
        RLPReader.RLPItem[] memory fields = RLPReader.readList(account);
        if (fields.length != ACCOUNT_FIELDS) revert BadProofValue();
        bytes memory root = RLPReader.readBytes(fields[STORAGE_ROOT_FIELD]);
        if (root.length != 32) revert BadProofValue();
        // forge-lint: disable-next-line(unsafe-typecast) — exactly 32 bytes, checked above.
        return bytes32(root);
    }

    /// `holder`'s SPX balance at the proven block, proven from SPX's storage root. A storage
    /// trie holds each value as RLP of its big-endian bytes, leading zeros dropped.
    function _balance(bytes32 storageRoot, address holder, bytes[] calldata storageProof)
        private
        pure
        returns (uint256 balance)
    {
        bytes32 slot = keccak256(abi.encode(holder, BALANCE_SLOT));
        bytes memory value =
            RLPReader.readBytes(SecureMerkleTrie.get(abi.encodePacked(slot), storageProof, storageRoot));
        if (value.length > 32) revert BadProofValue();
        for (uint256 i; i < value.length; i++) {
            balance = (balance << 8) | uint8(value[i]);
        }
    }
}
