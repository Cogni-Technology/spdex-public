// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.33;

import {ForkTest, Plan} from "./utils/Fork.sol";
import {Test} from "./utils/Test.sol";
import {SpdexDcaVault} from "../../contracts/SpdexDcaVault.sol";
import {ClonesWithArgs} from "../../contracts/libraries/ClonesWithArgs.sol";
import {Args, VaultArgs} from "../../contracts/libraries/VaultArgs.sol";

/// An implementation that only reads its clone's arguments back, three ways: through
/// `VaultArgs.read` (what the vault does), with `EXTCODECOPY` of its own address, and with
/// `CODECOPY` — the classic mistake.
contract ArgsEcho {
    function echo() external view returns (Args memory) {
        return VaultArgs.read();
    }

    function viaExtcodecopy() external view returns (bytes memory data) {
        data = new bytes(VaultArgs.LENGTH);
        assembly ("memory-safe") {
            extcodecopy(address(), add(data, 0x20), 0x2d, 117)
        }
    }

    function viaCodecopy() external pure returns (bytes memory data) {
        data = new bytes(VaultArgs.LENGTH);
        assembly ("memory-safe") {
            codecopy(add(data, 0x20), 0x2d, 117)
        }
    }
}

/// The clone mechanics on their own, with no market: pure arithmetic on code.
contract ClonesTest is Test {
    ArgsEcho internal echo;

    function setUp() public {
        echo = new ArgsEcho();
    }

    function cloneOf(address implementation, bytes memory args) internal returns (address) {
        return ClonesWithArgs.deploy(implementation, args, keccak256(args));
    }

    function encode(Args memory a) external pure returns (bytes memory) {
        return VaultArgs.encode(a);
    }

    /// Every field, at any value its width allows, comes back from the clone's code exactly —
    /// and from the pure decoder too.
    function testFuzz_argsRoundTrip(
        address owner,
        address tokenOut,
        address pair,
        address oraclePool,
        uint64 amountPerBuy,
        uint64 keeperReward,
        uint64 startAt,
        uint32 interval,
        uint16 maxBuys,
        uint16 maxSlippageBps,
        uint32 communityWindow,
        uint8 turnBuckets
    ) public {
        Args memory a = Args({
            owner: owner,
            tokenOut: tokenOut,
            pair: pair,
            oraclePool: oraclePool,
            amountPerBuy: amountPerBuy,
            keeperReward: keeperReward,
            startAt: startAt,
            interval: interval,
            maxBuys: maxBuys,
            maxSlippageBps: maxSlippageBps,
            communityWindow: communityWindow,
            turnBuckets: turnBuckets
        });
        bytes memory args = VaultArgs.encode(a);
        assertEq(args.length, VaultArgs.LENGTH, "117 bytes");
        assertEq(abi.encode(VaultArgs.decode(args)), abi.encode(a), "decode(encode(a)) == a");

        address clone = cloneOf(address(echo), args);
        assertEq(abi.encode(ArgsEcho(clone).echo()), abi.encode(a), "read back from the clone's code");
    }

    /// The widest values, each at once: no field bleeds into its neighbour.
    function test_argsRoundTripAtEveryFieldsLimit() public {
        Args memory a = Args({
            owner: address(type(uint160).max),
            tokenOut: address(0),
            pair: address(type(uint160).max),
            oraclePool: address(0),
            amountPerBuy: type(uint64).max,
            keeperReward: 0,
            startAt: type(uint64).max,
            interval: 0,
            maxBuys: type(uint16).max,
            maxSlippageBps: 0,
            communityWindow: type(uint32).max,
            turnBuckets: 0
        });
        address clone = cloneOf(address(echo), VaultArgs.encode(a));
        assertEq(abi.encode(ArgsEcho(clone).echo()), abi.encode(a), "alternating extremes survive");
    }

    /// A figure wider than its field is refused rather than truncated.
    function test_encodeRefusesAFigureWiderThanItsField() public {
        Args memory a;
        bytes memory refused = abi.encodeWithSelector(VaultArgs.ArgOutOfRange.selector);
        for (uint256 field; field < 8; field++) {
            a = Args(address(1), address(2), address(3), address(4), 1, 1, 1, 1, 1, 1, 1, 1);
            if (field == 0) a.amountPerBuy = uint256(type(uint64).max) + 1;
            if (field == 1) a.keeperReward = uint256(type(uint64).max) + 1;
            if (field == 2) a.startAt = uint256(type(uint64).max) + 1;
            if (field == 3) a.interval = uint256(type(uint32).max) + 1;
            if (field == 4) a.maxBuys = uint256(type(uint16).max) + 1;
            if (field == 5) a.maxSlippageBps = uint256(type(uint16).max) + 1;
            if (field == 6) a.communityWindow = uint256(type(uint32).max) + 1;
            if (field == 7) a.turnBuckets = uint256(type(uint8).max) + 1;
            vm.expectRevert(refused);
            this.encode(a);
        }
    }

    /// The trap: under `delegatecall`, CODECOPY reads the code that is running — the
    /// implementation's — not the clone's. EXTCODECOPY of `address()` reads the clone's,
    /// where the arguments are.
    function test_codecopyReadsTheImplementationNotTheClone() public {
        bytes memory args =
            VaultArgs.encode(Args(address(1), address(2), address(3), address(4), 5, 6, 7, 8, 9, 10, 11, 12));
        address clone = cloneOf(address(echo), args);

        assertEq(ArgsEcho(clone).viaExtcodecopy(), args, "EXTCODECOPY(address()) reads the clone's arguments");
        bytes memory wrong = ArgsEcho(clone).viaCodecopy();
        assertTrue(keccak256(wrong) != keccak256(args), "CODECOPY does not");
        assertEq(wrong, slice(address(echo).code, 0x2d, 117), "it reads the implementation's own bytes");
    }

    /// The clone is exactly the standard EIP-1167 proxy for its implementation, then its
    /// arguments; and CREATE2 puts it where `predict` says.
    function test_aCloneIsTheStandardProxyThenItsArguments() public {
        bytes memory args =
            VaultArgs.encode(Args(address(1), address(2), address(3), address(4), 5, 6, 7, 8, 9, 10, 11, 12));
        bytes32 salt = keccak256("salt");
        address predicted = ClonesWithArgs.predict(address(echo), args, salt, address(this));
        address clone = ClonesWithArgs.deploy(address(echo), args, salt);
        assertEq(clone, predicted, "where predict said");
        assertEq(
            clone.code,
            abi.encodePacked(hex"363d3d373d3d3d363d73", address(echo), hex"5af43d82803e903d91602b57fd5bf3", args),
            "the 45-byte proxy, then the arguments"
        );

        // The same implementation, arguments and salt a second time: the address is taken.
        vm.expectRevert(abi.encodeWithSelector(ClonesWithArgs.CloneFailed.selector));
        this.deployAgain(address(echo), args, salt);
    }

    function deployAgain(address implementation, bytes memory args, bytes32 salt) external returns (address) {
        return ClonesWithArgs.deploy(implementation, args, salt);
    }

    function slice(bytes memory data, uint256 start, uint256 length) internal pure returns (bytes memory out) {
        out = new bytes(length);
        for (uint256 i; i < length; i++) {
            out[i] = data[start + i];
        }
    }
}

/// The implementation the factory deployed, called directly rather than through a clone.
contract ImplementationTest is ForkTest {
    function expectNotAClone(bytes memory call, uint256 value) internal {
        address implementation = factory.implementation();
        vm.deal(stranger, value);
        vm.prank(stranger);
        (bool ok, bytes memory reason) = implementation.call{value: value}(call);
        assertTrue(!ok, "refused");
        assertEq(reason, abi.encodeWithSelector(SpdexDcaVault.NotAClone.selector), "as not a clone");
    }

    /// It has no plan, so every call that concerns one is refused — writes and reads alike,
    /// ether included — rather than answered with zeros someone might take for a vault's.
    function test_theImplementationRefusesEveryCallAboutAPlan() public {
        expectNotAClone(abi.encodeCall(SpdexDcaVault.fund, ()), 1 ether);
        expectNotAClone(abi.encodeCall(SpdexDcaVault.close, ()), 0);
        expectNotAClone(abi.encodeCall(SpdexDcaVault.rescue, (WETH)), 0);
        expectNotAClone(abi.encodeCall(SpdexDcaVault.execute, (stranger)), 0);
        expectNotAClone(abi.encodeCall(SpdexDcaVault.owner, ()), 0);
        expectNotAClone(abi.encodeCall(SpdexDcaVault.terms, ()), 0);
        expectNotAClone(abi.encodeCall(SpdexDcaVault.buysDone, ()), 0);
        expectNotAClone(abi.encodeCall(SpdexDcaVault.lastBuyAt, ()), 0);
        expectNotAClone(abi.encodeCall(SpdexDcaVault.closed, ()), 0);
        expectNotAClone(abi.encodeCall(SpdexDcaVault.windowBuys, ()), 0);
        expectNotAClone(abi.encodeCall(SpdexDcaVault.totalOut, ()), 0);
        expectNotAClone(abi.encodeCall(SpdexDcaVault.status, ()), 0);
        expectNotAClone(abi.encodeCall(SpdexDcaVault.quote, ()), 0);
        expectNotAClone(abi.encodeCall(SpdexDcaVault.totalRewards, ()), 0);
        expectNotAClone("", 1 ether);

        // What it does answer is true of every clone: its limits, the WETH it pays with and
        // the registry it asks.
        SpdexDcaVault implementation = SpdexDcaVault(payable(factory.implementation()));
        assertEq(implementation.MAX_FUNDING(), 0.5 ether, "the cap");
        assertEq(implementation.MIN_COMMUNITY_WINDOW(), 60, "the shortest window");
        assertEq(address(implementation.weth()), WETH, "WETH");
        assertEq(address(implementation.registry()), registry, "the registry");
    }

    /// The same calls through a factory clone all answer.
    function test_aCloneAnswersThem() public {
        Plan memory t = defaultPlan();
        SpdexDcaVault vault = createFunded(t);
        assertEq(vault.owner(), owner, "owner");
        assertEq(vault.terms().amountPerBuy, t.amountPerBuy, "terms");
        vault.status();
        vault.quote();
        vm.prank(keeper);
        vault.execute(keeper);
        assertEq(vault.buysDone(), 1, "bought");
        assertEq(vault.windowBuys(), 1, "inside its window, by a holder");
        assertEq(vault.totalRewards(), t.keeperReward, "rewarded");
        assertEq(address(vault).code.length, 45 + 117, "a 162-byte clone");
    }
}
