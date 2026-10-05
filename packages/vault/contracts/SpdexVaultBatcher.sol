// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.33;

import {IERC20Minimal} from "./interfaces/External.sol";

/// @title SpdexVaultBatcher — triggers many due vault buys in one transaction
/// @author spDEX
/// @notice UNAUDITED. No owner, no admin, no fee, no storage but a transient lock. Bound to no
///         factory and no release: it calls `execute(rewardTo)` on each address its caller
///         lists, each told to pay its fee straight to the address the caller names, and
///         measures what that address earned. It never receives a reward from a batch it
///         runs, and has no way to send WETH (any sent or paid to it otherwise stays here).
///         Anyone may call it; it is one more caller of each vault's `execute`, with no rights
///         a direct caller lacks.
///
/// ## Why it exists
///
/// A buy's own work is about 100,000 gas; a transaction that makes it alone pays about as
/// much again for being a transaction. A keeper that makes ten due buys in one transaction
/// pays that second part once, which is what lets a vault's buy fee be a small share of a
/// small buy. This contract is that one transaction: it calls `execute` on each vault in a
/// list, naming the caller's `rewardTo` to each, and measures what they paid.
///
/// ## Why it cannot hurt a vault or its owner
///
/// Each vault still decides everything but *when* and who receives the caller's own fee:
/// the amount, the token, the recipient of what is bought and the floor are fixed in its
/// code, and a buy that breaks any of them reverts. Each vault pays its reward straight to
/// `rewardTo`, which whoever called this contract chose; this contract passes the same
/// `rewardTo` to every vault in the list and nothing else. It keeps nothing and charges
/// nothing, and nobody holds any switch over it.
///
/// ## Why it is bound to no factory
///
/// v1's batcher, and v2's first draft, were each bound to one factory and called only the
/// vaults it vouched for, because they added up what the vaults *reported* paying and had to
/// trust the reports. This one trusts no report: what a batch earned is how much `rewardTo`'s
/// WETH balance rose while it ran, which no contract in the list can make larger without
/// paying it. With nothing left to trust, the binding had nothing left to protect, and
/// dropping it means one batcher serves every release whose vaults take `execute(rewardTo)`
/// and pay their fee in WETH — this one, and any later one built the same way — and a batch
/// may mix them. A later release, or a later market list, needs no batcher of its own.
///
/// Which vaults are worth calling is the caller's to know: a keeper takes them from factories
/// it trusts (`isVault`), and spDEX's app and keeper from the factories they list. A list that
/// names something else only costs its own caller: such an address runs with the gas the
/// caller gave it (`gasPerVault`), as a stranger's vault would, and counts as a buy only if it
/// answers like one. Its `Triggered` log says only that something answered; a report counts
/// buys from the `Bought` logs of vaults a listed factory vouches for, never from these.
///
/// ## Why no WETH passes through it
///
/// In v1 each vault paid its caller, the batcher, which forwarded the rewards and swept any
/// WETH it held. From v2 a vault pays the `rewardTo` it is given, and inside a community
/// window checks that address with the SPX holder registry: it has to be the real recipient,
/// not this contract. So there is no forwarding and no sweep. This contract never receives a
/// reward from a batch it runs (it refuses itself as `rewardTo`), and has no way to send
/// WETH: WETH anyone sends it by mistake stays here, as it would at any contract that never
/// transfers it, and so does a fee a direct caller of a vault names this contract to receive
/// after the window — that caller's own fee, lost by its own choice
/// (`test_aFeeNamedToTheBatcherByADirectCallerStaysThere`).
///
/// ## Why one vault cannot sink the batch
///
/// Each vault runs inside its own call, capped at `gasPerVault`, and a vault that refuses —
/// not due, outside its floor, not eligible inside its window, anything — is recorded and
/// skipped, so the others still buy. Only 32 bytes of a success and 4 bytes of a refusal are
/// ever copied back, so a vault cannot make this contract pay to copy a huge answer. When the
/// transaction's gas runs short, the vaults left are not tried at all (`NotTried`), rather
/// than tried with too little gas and recorded as refusing.
///
/// The cap is the caller's, between `MIN_EXECUTE_GAS` and `MAX_EXECUTE_GAS`, rather than a
/// constant, because nothing can change it once this is deployed: a fork that reprices the
/// reads a buy makes would otherwise leave every buy short of gas here, for good. An honest
/// buy of SPX needs at most about 320,000 today, its community window's check included.
///
/// ## Why it reverts when nothing, or too little, was bought
///
/// A batch that bought nothing earned nothing. Reverting it lets a private relay that drops
/// reverting transactions (Flashbots Protect, MEV Blocker) drop it for free: a keeper that
/// lost a race to another loses nothing. `minRewards` does the same for a partial race: the
/// caller names the least it accepts earning, and a batch that would earn less does not
/// happen. Neither is a condition on any vault: a revert is the same as not having sent.
/// An `eth_call` of such a batch returns why each vault would refuse — `NotEligible`, for
/// one still inside its community window when `rewardTo` may not be paid there, or
/// `NotYourTurn`, inside the first half of one with turns.
contract SpdexVaultBatcher {
    /// The least gas a caller may give each vault's `execute`: `MAX_EXECUTE_GAS_LIMIT` in
    /// `src/index.ts`, the most a keeper lets one buy use today. Below it an honest buy of SPX
    /// could run out, and every vault would be recorded as refusing.
    uint256 public constant MIN_EXECUTE_GAS = 400_000;
    /// The most: a sanity bound, under what one transaction may spend (EIP-7825's 16,777,216),
    /// so that an attempt at the most still fits in one.
    uint256 public constant MAX_EXECUTE_GAS = 10_000_000;
    /// The most vaults one call takes. A sanity bound: the per-transaction gas limit of
    /// EIP-7825 (16,777,216) runs out first, at about 40 attempts that each burn the least cap.
    uint256 public constant MAX_VAULTS = 150;
    /// The gas that must be left before a vault is attempted beyond the cap itself, so that
    /// the vault gets exactly `gasPerVault` despite the 63/64 rule and the batch can still
    /// finish. Before each attempt there must be `gasPerVault × 64/63` (rounded up: the call's
    /// cap after the 1/64 kept back) plus this:
    ///   +   2,600  cold access to the vault
    ///   +   2,500  the vault's event and bookkeeping after the call
    ///   +  43,150  finishing, at its dearest when an early attempt burns its cap: every vault
    ///              left marked `NotTried` (about 150 gas each, up to `MAX_VAULTS` − 1 of
    ///              them), `rewardTo`'s WETH balance read again (warm), then `Batch` and the
    ///              150 reasons encoded on the way out, or a revert that encodes them. The
    ///              dearest end measured needs about 37,000 after the attempt
    ///   +   5,400  spare: what v1 and the first v2 draft spent asking their factory whether
    ///              each address was its vault, kept so the least cap still needs exactly the
    ///              460,000 a keeper budgets an attempt (`batchGasLimit`)
    ///   =  53,650
    /// Pinned by `test_theBatchFinishesWhenTheLastAttemptBurnsTheCap`,
    /// `test_theLongestListStillRevertsWithEveryReasonWhenTheLastBurnsTheCap` and the two
    /// `test_aLongListWhose…AttemptBurnsTheCap…` tests (an early burn, on the way to a revert
    /// and to a success), which print what each end leaves.
    uint256 public constant ATTEMPT_OVERHEAD = 53_650;

    /// The WETH every vault pays its fee in: what `earned` measures.
    IERC20Minimal public immutable weth;

    /// Held for the whole of `executeBatch`, in transient storage. A vault's `execute` is the
    /// only outside code this contract runs, and nothing here needs to run inside it: a
    /// nested batch from inside one would interleave its buys, events and `earned` with this
    /// one's, for no purpose a second transaction could not serve.
    bool private transient locked;

    /// One per batch that went through. `listed` is how many vaults the caller named and
    /// `tried` how many were attempted (the rest ran out of gas, `NotTried`); `earned` is how
    /// much `rewardTo`'s WETH balance rose during this call.
    event Batch(
        address indexed caller, address indexed rewardTo, uint256 listed, uint256 tried, uint256 bought, uint256 earned
    );
    /// One per address that answered as a buy does: always the log right after that vault's
    /// `Bought`, for a vault; what the owner received (`execute`'s first answer), and the gas
    /// the attempt cost this transaction.
    event Triggered(address indexed vault, uint256 received, uint256 gasUsed);
    /// One per vault attempted that did not buy: the first 4 bytes of its refusal, or one of
    /// the reason codes below, and the gas the attempt cost.
    event NotTriggered(address indexed vault, bytes4 indexed reason, uint256 gasUsed);

    /// The WETH named has no code.
    error NoWeth(address weth);
    error Reentrancy();
    /// `rewardTo` is the zero address, or this contract, which must end every call empty.
    error BadRewardTo(address rewardTo);
    error TooManyVaults(uint256 count, uint256 max);
    /// `gasPerVault` is outside `MIN_EXECUTE_GAS` to `MAX_EXECUTE_GAS`.
    error GasOutOfRange(uint256 gasPerVault, uint256 min, uint256 max);
    /// No vault bought. `reasons` is aligned with the list, one per vault.
    error NothingBought(bytes4[] reasons);
    /// The vaults that bought raised `rewardTo`'s WETH by less than the caller's `minRewards`.
    error TooLittle(uint256 earned, uint256 minRewards, bytes4[] reasons);

    // Reason codes, never thrown: what `NotTriggered` and the `reasons` list say for an
    // outcome that has no refusal of the vault's own to report.

    /// The call reverted with less than 4 bytes of data: it ran out of gas, reverted bare, or
    /// found no `execute(address)` there at all (a v1 vault, an account).
    error EmptyRevert();
    /// The call succeeded with less than 64 bytes of answer: not a vault's buy, so not
    /// counted as one.
    error EmptyReturn();
    /// Not attempted: the transaction's gas ran below what an attempt needs first. Not a
    /// refusal; nothing about the vault is known.
    error NotTried();

    /// @dev WETH must exist already: it is what `earned` is measured in.
    constructor(address weth_) {
        // Reading a balance of an address with no code fails in a way nothing can name; a
        // mistyped WETH deserves this error instead, rather than a batcher whose every batch
        // reverts.
        if (weth_.code.length == 0) revert NoWeth(weth_);
        weth = IERC20Minimal(weth_);
    }

    /// @notice Trigger each vault in `vaults`, in order, each paying its reward to `rewardTo`.
    /// @param rewardTo Who every vault in the batch pays. A vault still inside its community
    ///        window refuses (`NotEligible`) unless this is eligible, or its owner.
    /// @param minRewards The least WETH the caller accepts earning from this call; 0 = any.
    /// @param gasPerVault The gas each vault's `execute` is given: `MIN_EXECUTE_GAS` to
    ///        `MAX_EXECUTE_GAS`. What a vault built to burn a keeper's gas can take from the
    ///        batch.
    /// @return bought How many vaults bought.
    /// @return earned How much `rewardTo`'s WETH rose: what `Batch.earned` says.
    /// @return reasons Aligned with `vaults`: bytes4(0) where that vault bought, else why not.
    function executeBatch(address[] calldata vaults, address rewardTo, uint256 minRewards, uint256 gasPerVault)
        external
        returns (uint256 bought, uint256 earned, bytes4[] memory reasons)
    {
        if (locked) revert Reentrancy();
        locked = true;
        if (rewardTo == address(0) || rewardTo == address(this)) revert BadRewardTo(rewardTo);
        uint256 n = vaults.length;
        if (n > MAX_VAULTS) revert TooManyVaults(n, MAX_VAULTS);
        if (gasPerVault < MIN_EXECUTE_GAS || gasPerVault > MAX_EXECUTE_GAS) {
            revert GasOutOfRange(gasPerVault, MIN_EXECUTE_GAS, MAX_EXECUTE_GAS);
        }
        // The cap after the 1/64 the EVM keeps back, rounded up, and what the attempt and
        // the end of the batch need beside it.
        uint256 minGas = gasPerVault + (gasPerVault + 62) / 63 + ATTEMPT_OVERHEAD;

        uint256 before = weth.balanceOf(rewardTo);
        reasons = new bytes4[](n);
        uint256 tried;
        for (uint256 i; i < n; i++) {
            if (gasleft() < minGas) {
                for (uint256 j = i; j < n; j++) {
                    reasons[j] = NotTried.selector;
                }
                break;
            }
            tried++;
            (bool didBuy, bytes4 reason) = _trigger(vaults[i], rewardTo, gasPerVault);
            if (didBuy) bought++;
            else reasons[i] = reason;
        }
        // Only a contract `rewardTo` approved could have moved its WETH down; what it earned
        // then is nothing, not a negative.
        uint256 afterward = weth.balanceOf(rewardTo);
        earned = afterward > before ? afterward - before : 0;
        if (bought == 0) revert NothingBought(reasons);
        if (earned < minRewards) revert TooLittle(earned, minRewards, reasons);
        emit Batch(msg.sender, rewardTo, n, tried, bought, earned);
        locked = false;
    }

    /// One vault's attempt: its `execute(rewardTo)`, with exactly `gasPerVault`, and its event.
    function _trigger(address vault, address rewardTo, uint256 gasPerVault)
        private
        returns (bool didBuy, bytes4 reason)
    {
        uint256 before = gasleft();
        bool ok;
        uint256 size;
        uint256 received;
        // A plain call with no automatic copy of what comes back: 32 bytes of a success and 4
        // of a refusal are all that is read, so a vault answering megabytes costs nothing
        // here beyond its own gas. The 36 bytes of calldata and the word of answer fit in
        // scratch space (0x00 to 0x3f), so nothing is allocated.
        assembly ("memory-safe") {
            mstore(0x00, shl(224, 0x4b64e492)) // execute(address)
            mstore(0x04, rewardTo)
            ok := call(gasPerVault, vault, 0, 0x00, 0x24, 0, 0)
            size := returndatasize()
            switch ok
            case 0 {
                if gt(size, 3) {
                    returndatacopy(0, 0, 4)
                    reason := and(mload(0), shl(224, 0xffffffff))
                }
            }
            default {
                if gt(size, 63) {
                    returndatacopy(0, 0, 32)
                    received := mload(0)
                }
            }
        }
        uint256 used = before - gasleft();
        if (ok && size >= 64) {
            emit Triggered(vault, received, used);
            return (true, bytes4(0));
        }
        // bytes4(0) means "bought" in `reasons`, so a refusal must never be recorded as it,
        // even when a vault's revert data starts with four zero bytes.
        if (ok) reason = EmptyReturn.selector;
        else if (reason == bytes4(0)) reason = EmptyRevert.selector;
        emit NotTriggered(vault, reason, used);
        return (false, reason);
    }
}
