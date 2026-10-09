// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.33;

/// @title ClonesWithArgs: EIP-1167 minimal proxies that carry immutable arguments in their code
/// @notice The pattern OpenZeppelin's `Clones.cloneDeterministicWithImmutableArgs` (5.1, MIT)
///         and Solady's `LibClone` (MIT) use, written out in the few lines this project needs.
///         The bytes are the standard ones, so any tool that recognises an EIP-1167 clone
///         recognises these.
/// @dev A clone's runtime code is the 45-byte EIP-1167 proxy — "delegate every call to
///      `implementation` and hand back whatever it returns" — followed by `args`, which the
///      proxy never executes (it always returns or reverts before reaching them). So the
///      arguments are part of the clone's code: set once by the creating transaction, never
///      writable, and readable by the implementation's code as it runs for the clone.
///
///      Reading them back has one trap, and it is the reason `readArgs` exists rather than
///      each caller writing its own. Under `delegatecall`, `address()` is the clone but the
///      code executing is the implementation's. `CODECOPY` copies *the executing code*, so
///      it would read the implementation's bytes at that offset — which carry no arguments —
///      while `EXTCODECOPY(address(), …)` reads the clone's, which do.
///      `test/forge/Clones.t.sol` shows both.
library ClonesWithArgs {
    /// Where the arguments start in a clone's code: right after the 45-byte proxy.
    uint256 internal constant ARGS_OFFSET = 0x2d;

    /// Deployed code is capped at 24,576 bytes (EIP-170); the proxy takes 45 of them.
    error CloneArgsTooLong();
    /// CREATE2 failed: something already lives at the address (the same implementation,
    /// arguments and salt were used before), or the creation ran out of gas.
    error CloneFailed();

    /// The init code that deploys a clone of `implementation` carrying `args`.
    /// @dev The ten-byte prefix copies the rest of the init code — proxy and arguments — to
    ///      memory and returns it as the new contract's code:
    ///      `PUSH2 len  RETURNDATASIZE  DUP2  PUSH1 0x0a  RETURNDATASIZE  CODECOPY  RETURN`
    ///      (RETURNDATASIZE is a cheap zero before any call). Then the EIP-1167 runtime with the
    ///      implementation's address in it, then the arguments.
    function initCode(address implementation, bytes memory args) internal pure returns (bytes memory) {
        if (args.length > 0x5fd3) revert CloneArgsTooLong();
        return abi.encodePacked(
            hex"61",
            // forge-lint: disable-next-line(unsafe-typecast) — bounded to 0x6000 just above.
            uint16(args.length + ARGS_OFFSET),
            hex"3d81600a3d39f3",
            hex"363d3d373d3d3d363d73",
            implementation,
            hex"5af43d82803e903d91602b57fd5bf3",
            args
        );
    }

    /// Deploy a clone at the CREATE2 address `predict` gives for the same inputs.
    /// @dev No ether goes with it: a clone's creation runs only the prefix above, so nothing
    ///      could account for it.
    function deploy(address implementation, bytes memory args, bytes32 salt) internal returns (address instance) {
        bytes memory code = initCode(implementation, args);
        assembly ("memory-safe") {
            instance := create2(0, add(code, 0x20), mload(code), salt)
        }
        if (instance == address(0)) revert CloneFailed();
    }

    /// Where `deployer` would put this clone: the CREATE2 address of its init code.
    function predict(address implementation, bytes memory args, bytes32 salt, address deployer)
        internal
        pure
        returns (address)
    {
        bytes32 codeHash = keccak256(initCode(implementation, args));
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), deployer, salt, codeHash)))));
    }

    /// The first `length` bytes of arguments in the code of the contract this code is running
    /// for — the clone, when called through one. See the trap described above.
    function readArgs(uint256 length) internal view returns (bytes memory args) {
        args = new bytes(length);
        assembly ("memory-safe") {
            extcodecopy(address(), add(args, 0x20), ARGS_OFFSET, length)
        }
    }
}
