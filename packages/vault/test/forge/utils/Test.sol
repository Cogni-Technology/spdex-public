// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.33;

// A minimal test harness: the cheatcodes and assertions these tests use, and nothing
// else. It stands in for forge-std so that the contracts build and test offline from
// this repository alone — no git submodule to fetch, no second copy of a library whose
// version would have to be pinned as carefully as the compiler is.

struct VmLog {
    bytes32[] topics;
    bytes data;
    address emitter;
}

/// The cheatcodes used here, with the signatures forge implements at this address.
interface Vm {
    function createSelectFork(string calldata urlOrAlias, uint256 blockNumber) external returns (uint256);
    function envOr(string calldata name, string calldata defaultValue) external view returns (string memory);
    function warp(uint256 newTimestamp) external;
    function roll(uint256 newHeight) external;
    function deal(address account, uint256 newBalance) external;
    function store(address target, bytes32 slot, bytes32 value) external;
    function prank(address msgSender) external;
    function startPrank(address msgSender) external;
    function stopPrank() external;
    function expectRevert(bytes calldata revertData) external;
    function expectRevert() external;
    function expectPartialRevert(bytes4 revertData) external;
    function recordLogs() external;
    function getRecordedLogs() external returns (VmLog[] memory);
    function label(address account, string calldata newLabel) external;
    function addr(uint256 privateKey) external pure returns (address);
    /// Saves the whole EVM state, and puts it back: two calls compared from one moment.
    function snapshotState() external returns (uint256 snapshotId);
    function revertToState(uint256 snapshotId) external returns (bool success);
    /// Every call to `callee` whose calldata starts with `data` reverts with `revertData`, until
    /// `clearMockedCalls`: how a test makes a contract it cannot change fail.
    function mockCallRevert(address callee, bytes calldata data, bytes calldata revertData) external;
    function clearMockedCalls() external;
    function toString(uint256 value) external pure returns (string memory);
    /// Marks `target` and its storage cold again, as a new transaction would find them.
    function cool(address target) external;
}

/// forge's console: a call to this address with a known signature is printed with `-vv`.
library console {
    address private constant CONSOLE = 0x000000000000000000636F6e736F6c652e6c6f67;

    function log(string memory label, uint256 value) internal view {
        _send(abi.encodeWithSignature("log(string,uint256)", label, value));
    }

    function log(string memory label, address value) internal view {
        _send(abi.encodeWithSignature("log(string,address)", label, value));
    }

    function log(string memory label, int256 value) internal view {
        _send(abi.encodeWithSignature("log(string,int256)", label, value));
    }

    function _send(bytes memory payload) private view {
        // A staticcall to an address with no code succeeds and does nothing, which is
        // exactly right outside forge; forge intercepts it and prints.
        (bool ok,) = CONSOLE.staticcall(payload);
        ok;
    }
}

abstract contract Test {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    error AssertionFailed(string message);

    function fail(string memory message) internal pure {
        revert AssertionFailed(message);
    }

    function assertTrue(bool condition, string memory message) internal pure {
        if (!condition) fail(message);
    }

    function assertEq(uint256 a, uint256 b, string memory message) internal pure {
        if (a != b) fail(string.concat(message, ": ", _str(a), " != ", _str(b)));
    }

    function assertEq(address a, address b, string memory message) internal pure {
        if (a != b) fail(message);
    }

    function assertEq(bytes32 a, bytes32 b, string memory message) internal pure {
        if (a != b) fail(message);
    }

    function assertEq(bytes memory a, bytes memory b, string memory message) internal pure {
        if (keccak256(a) != keccak256(b)) fail(message);
    }

    function assertGe(uint256 a, uint256 b, string memory message) internal pure {
        if (a < b) fail(string.concat(message, ": ", _str(a), " < ", _str(b)));
    }

    function assertLt(uint256 a, uint256 b, string memory message) internal pure {
        if (a >= b) fail(string.concat(message, ": ", _str(a), " >= ", _str(b)));
    }

    function assertGt(uint256 a, uint256 b, string memory message) internal pure {
        if (a <= b) fail(string.concat(message, ": ", _str(a), " <= ", _str(b)));
    }

    /// A fresh address with no code and no history, derived from a label.
    function makeAddr(string memory name) internal returns (address account) {
        account = vm.addr(uint256(keccak256(bytes(name))));
        vm.label(account, name);
    }

    function _str(uint256 value) private pure returns (string memory) {
        if (value == 0) return "0";
        uint256 digits;
        for (uint256 v = value; v != 0; v /= 10) {
            digits++;
        }
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits -= 1;
            buffer[digits] = bytes1(uint8(48 + (value % 10)));
            value /= 10;
        }
        return string(buffer);
    }
}
