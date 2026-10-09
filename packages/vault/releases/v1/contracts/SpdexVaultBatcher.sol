// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.33;

import {IVaultFactoryMinimal, IWETH9} from "./interfaces/External.sol";

/// @title SpdexVaultBatcher — triggers many due vault buys in one transaction
/// @author spDEX
/// @notice UNAUDITED. No owner, no admin, no fee, no storage but a transient lock. Bound at
///         construction to one factory; triggers only vaults it vouches for; forwards every
///         wei of WETH it holds to the address its caller names, in the same transaction, and
///         holds nothing between calls. Anyone may call it; it is one more caller of each
///         vault's `execute`, with no rights a direct caller lacks.
///
/// ## Why it exists
///
/// A buy's own work is about 100,000 gas; a transaction that makes it alone pays about as
/// much again for being a transaction. A keeper that makes ten due buys in one transaction
/// pays that second part once, which is what lets a vault's buy fee be a small share of a
/// small buy. This contract is that one transaction: it calls `execute` on each vault in a
/// list and hands the rewards on.
///
/// ## Why it cannot hurt a vault or its owner
///
/// Each vault still decides everything but *when*: the amount, the token, the recipient and
/// the floor are fixed in its code, and a buy that breaks any of them reverts. The vault
/// pays its reward to its caller, which here is this contract, and this contract passes it
/// on, in the same transaction, to `rewardTo`: whoever called it chose where their own
/// reward goes. It keeps nothing and charges nothing, and nobody holds any switch over it.
///
/// ## Why one vault cannot sink the batch
///
/// Each vault runs inside its own call, capped at `EXECUTE_GAS_CAP`, and a vault that
/// refuses — not due, outside its floor, anything — is recorded and skipped, so the others
/// still buy. Only 32 bytes of a success and 4 bytes of a refusal are ever copied back, so a
/// vault cannot make this contract pay to copy a huge answer. A vault the factory does not
/// vouch for is skipped without being called. When the transaction's gas runs short, the
/// vaults left are not tried at all (`NotTried`), rather than tried with too little gas and
/// recorded as refusing.
///
/// ## Why it reverts when nothing, or too little, was bought
///
/// A batch that bought nothing earned nothing. Reverting it lets a private relay that drops
/// reverting transactions (Flashbots Protect, MEV Blocker) drop it for free: a keeper that
/// lost a race to another loses nothing. `minRewards` does the same for a partial race: the
/// caller names the least it accepts earning, and a batch that would earn less does not
/// happen. Neither is a condition on any vault: a revert is the same as not having sent.
/// An `eth_call` of such a batch returns why each vault would refuse.
///
/// ## What `Batch.swept` is
///
/// Anyone can send this contract WETH. Whatever it holds when a batch starts goes to
/// `rewardTo` with the rewards — so nothing is ever left here — but it is reported apart,
/// as `swept`, and never counted as `earned` or towards `minRewards`: a keeper's revenue is
/// what the vaults paid, and nothing else.
contract SpdexVaultBatcher {
    /// The gas each vault's `execute` is given: `MAX_EXECUTE_GAS_LIMIT` in `src/index.ts`,
    /// the most a keeper lets one buy use. An honest buy of SPX needs at most about 320,000,
    /// and this is what a vault built to burn a keeper's gas can take from a batch.
    uint256 public constant EXECUTE_GAS_CAP = 400_000;
    /// The most vaults one call takes. A sanity bound: the per-transaction gas limit of
    /// EIP-7825 (16,777,216) runs out first, at about 40 attempts that each burn their cap.
    uint256 public constant MAX_VAULTS = 150;
    /// The gas that must be left before a vault is attempted, so that it gets exactly
    /// `EXECUTE_GAS_CAP` despite the 63/64 rule and the batch can still finish:
    ///     406,350  400,000 × 64/63, rounded up: the call's cap after the 1/64 kept back
    ///   +   5,400  `isVault`, at worst (a cold factory account and a cold mapping slot)
    ///   +   2,600  cold access to the vault
    ///   +   2,500  the vault's event and bookkeeping after the call
    ///   +  43,150  finishing: WETH's `balanceOf`, the `minRewards` check, the transfer to a
    ///              cold `rewardTo` holding no WETH, and `Batch`; or a revert that encodes
    ///              `MAX_VAULTS` reasons
    ///   = 460,000
    /// `test_theBatchFinishesWhenTheLastAttemptBurnsTheCap` pins that it is enough.
    uint256 public constant MIN_GAS_PER_ATTEMPT = 460_000;

    /// The one factory whose vaults this contract triggers.
    address public immutable factory;
    /// The WETH that factory's vaults pay rewards in.
    IWETH9 public immutable weth;

    /// Held for the whole of `executeBatch`, in transient storage: a vault's `execute` is the
    /// only outside code this contract runs, and a nested batch from inside one could
    /// otherwise send the rewards collected so far to another `rewardTo`.
    bool private transient locked;

    /// One per batch that went through. `listed` is how many vaults the caller named and
    /// `tried` how many were attempted (the rest ran out of gas, `NotTried`); `earned` is
    /// the WETH the vaults paid during this call, and `swept` what this contract already
    /// held when it started. `rewardTo` received `earned + swept`.
    event Batch(
        address indexed caller,
        address indexed rewardTo,
        uint256 listed,
        uint256 tried,
        uint256 bought,
        uint256 earned,
        uint256 swept
    );
    /// One per vault that bought, always the log right after that vault's `Bought`: what the
    /// owner received (`execute`'s answer), and the gas the attempt cost this transaction.
    event Triggered(address indexed vault, uint256 received, uint256 gasUsed);
    /// One per vault attempted that did not buy: the first 4 bytes of its refusal, or one of
    /// the reason codes below, and the gas the attempt cost.
    event NotTriggered(address indexed vault, bytes4 indexed reason, uint256 gasUsed);

    error NoFactory(address factory);
    error Reentrancy();
    /// `rewardTo` is the zero address, or this contract, which must end every call empty.
    error BadRewardTo(address rewardTo);
    error TooManyVaults(uint256 count, uint256 max);
    /// No vault bought. `reasons` is aligned with the list, one per vault.
    error NothingBought(bytes4[] reasons);
    /// The vaults that bought paid less than the caller's `minRewards`.
    error TooLittle(uint256 earned, uint256 minRewards, bytes4[] reasons);
    error RewardTransferFailed();

    // Reason codes, never thrown: what `NotTriggered` and the `reasons` list say for an
    // outcome that has no refusal of the vault's own to report.

    /// The factory does not vouch for this address. It was not called.
    error NotFromFactory();
    /// The call reverted with less than 4 bytes of data: it ran out of gas, or reverted bare.
    error EmptyRevert();
    /// The call succeeded with less than 32 bytes of answer: not a vault's buy, so not
    /// counted as one.
    error EmptyReturn();
    /// Not attempted: the transaction's gas ran below `MIN_GAS_PER_ATTEMPT` first. Not a
    /// refusal; nothing about the vault is known.
    error NotTried();

    /// @dev Reads the factory's WETH once, here, so that no batch trusts anything but the
    ///      factory it was deployed for.
    constructor(address factory_) {
        // Calling a function on an address with no code fails in a way nothing can name; a
        // mistyped factory deserves this error instead.
        if (factory_.code.length == 0) revert NoFactory(factory_);
        factory = factory_;
        weth = IWETH9(IVaultFactoryMinimal(factory_).weth());
    }

    /// @notice Trigger each vault in `vaults` that the factory vouches for, in order, and send
    ///         every reward to `rewardTo`.
    /// @param minRewards The least WETH the caller accepts earning from this call; 0 = any.
    /// @return bought How many vaults bought.
    /// @return earned The WETH this call earned: what `Batch.earned` says.
    /// @return reasons Aligned with `vaults`: bytes4(0) where that vault bought, else why not.
    function executeBatch(address[] calldata vaults, address rewardTo, uint256 minRewards)
        external
        returns (uint256 bought, uint256 earned, bytes4[] memory reasons)
    {
        if (locked) revert Reentrancy();
        locked = true;
        if (rewardTo == address(0) || rewardTo == address(this)) revert BadRewardTo(rewardTo);
        uint256 n = vaults.length;
        if (n > MAX_VAULTS) revert TooManyVaults(n, MAX_VAULTS);

        // WETH someone sent here before this call: swept to `rewardTo` with the rewards, but
        // never counted as earned.
        uint256 swept = weth.balanceOf(address(this));
        reasons = new bytes4[](n);
        uint256 tried;
        for (uint256 i; i < n; i++) {
            if (gasleft() < MIN_GAS_PER_ATTEMPT) {
                for (uint256 j = i; j < n; j++) {
                    reasons[j] = NotTried.selector;
                }
                break;
            }
            tried++;
            (bool didBuy, bytes4 reason) = _trigger(vaults[i]);
            if (didBuy) bought++;
            else reasons[i] = reason;
        }
        if (bought == 0) revert NothingBought(reasons);

        uint256 balance = weth.balanceOf(address(this));
        earned = balance - swept;
        if (earned < minRewards) revert TooLittle(earned, minRewards, reasons);
        if (balance != 0 && !weth.transfer(rewardTo, balance)) revert RewardTransferFailed();
        emit Batch(msg.sender, rewardTo, n, tried, bought, earned, swept);
        locked = false;
    }

    /// One vault's attempt: skipped unless the factory vouches for it, else its `execute`,
    /// with exactly `EXECUTE_GAS_CAP`, and its event.
    function _trigger(address vault) private returns (bool didBuy, bytes4 reason) {
        if (!IVaultFactoryMinimal(factory).isVault(vault)) {
            emit NotTriggered(vault, NotFromFactory.selector, 0);
            return (false, NotFromFactory.selector);
        }
        uint256 before = gasleft();
        bool ok;
        uint256 size;
        uint256 received;
        // A plain call with no automatic copy of what comes back: 32 bytes of a success and 4
        // of a refusal are all that is read, so a vault answering megabytes costs nothing
        // here beyond its own gas.
        assembly ("memory-safe") {
            mstore(0, shl(224, 0x61461954)) // execute()
            ok := call(EXECUTE_GAS_CAP, vault, 0, 0, 4, 0, 0)
            size := returndatasize()
            switch ok
            case 0 {
                if gt(size, 3) {
                    returndatacopy(0, 0, 4)
                    reason := and(mload(0), shl(224, 0xffffffff))
                }
            }
            default {
                if gt(size, 31) {
                    returndatacopy(0, 0, 32)
                    received := mload(0)
                }
            }
        }
        uint256 used = before - gasleft();
        if (ok && size >= 32) {
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
