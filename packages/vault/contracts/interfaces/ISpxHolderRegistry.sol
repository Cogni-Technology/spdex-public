// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.33;

/// @title ISpxHolderRegistry — who may be paid a v2 vault's fee inside its community window
/// @notice Ownerless and immutable. Proves, from Ethereum's own state, that an address held
///         SPX. Nothing is deposited or locked and nobody keeps a list: the registry stores one
///         timestamp per address that has proven, and nothing else.
interface ISpxHolderRegistry {
    /// `holder` held at least MIN_SPX at the end of the block `header` describes, one of
    /// the last 8,191. Anyone may submit any holder's proof: it states a fact.
    /// Reverts with NotNewer when the proof would not move `validUntil`.
    function prove(address holder, bytes calldata header, bytes[] calldata accountProof, bytes[] calldata storageProof)
        external
        returns (uint64 validUntil);

    /// A proof is still valid, the holder is an account (no code, or only an EIP-7702
    /// delegation designator) rather than a contract, and it has at least MIN_SPX right now.
    function isEligible(address holder) external view returns (bool);

    /// When `holder`'s latest proof lapses (chain time, inclusive); 0 if it never proved.
    function validUntil(address holder) external view returns (uint64);

    event Proven(address indexed holder, uint256 indexed blockNumber, uint256 balance, uint64 validUntil);

    error NotNewer(uint64 validUntil);
}
