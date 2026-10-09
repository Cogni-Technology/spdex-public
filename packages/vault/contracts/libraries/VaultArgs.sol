// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.33;

import {ClonesWithArgs} from "./ClonesWithArgs.sol";

/// @notice One vault's terms as its clone carries them: who owns it, which market it buys on,
///         and the plan. Every figure is a uint256 in memory; `VaultArgs.encode` packs each into
///         the width below, which the factory's own bounds leave plenty of room in.
struct Args {
    address owner;
    /// The market, copied from the factory's list at creation.
    address tokenOut;
    address pair;
    address oraclePool;
    /// ≤ MAX_FUNDING (0.5 ether) < 2^64.
    uint256 amountPerBuy;
    /// ≤ amountPerBuy.
    uint256 keeperReward;
    /// Within a year of creation: < 2^64 for as long as anyone will care.
    uint256 startAt;
    /// ≤ MAX_INTERVAL (366 days) < 2^32.
    uint256 interval;
    /// ≤ MAX_BUYS (1,000) < 2^16.
    uint256 maxBuys;
    /// ≤ MAX_SLIPPAGE_BPS (500) < 2^16.
    uint256 maxSlippageBps;
    /// Seconds: MIN_COMMUNITY_WINDOW (60) to MAX_COMMUNITY_WINDOW (3,600) < 2^32.
    uint256 communityWindow;
    /// 0, or 2 to MAX_TURN_BUCKETS (64) < 2^8.
    uint256 turnBuckets;
}

/// @title VaultArgs: how a vault's terms are laid out in its clone's code
/// @dev Packed, in this order, 117 bytes in all:
///
///      | bytes | field           |
///      |-------|-----------------|
///      | 20    | owner           |
///      | 20    | tokenOut        |
///      | 20    | pair            |
///      | 20    | oraclePool      |
///      | 8     | amountPerBuy    |
///      | 8     | keeperReward    |
///      | 8     | startAt         |
///      | 4     | interval        |
///      | 2     | maxBuys         |
///      | 2     | maxSlippageBps  |
///      | 4     | communityWindow |
///      | 1     | turnBuckets     |
///
///      v1's 112 bytes, unchanged, then the window and its turns: v2 added two terms and
///      moved none. The registry a window is checked against is not here: it is the same for
///      every vault of a factory, so it is part of the implementation's code (an immutable),
///      not of each clone's.
///
///      Packed because each byte of a clone's code costs 200 gas to deploy, and a vault is
///      created far more often than any one field is read. `packages/vault/src/index.ts`
///      (`encodeVaultArgs`) writes the same layout for `predictVault`'s TypeScript twin, and
///      `test/forge/Clones.t.sol` round-trips it.
library VaultArgs {
    uint256 internal constant LENGTH = 117;

    /// A figure does not fit its field. The factory's bounds make this unreachable through
    /// it; it is here so that a future bound cannot silently truncate a term instead.
    error ArgOutOfRange();

    function encode(Args memory a) internal pure returns (bytes memory) {
        if (
            a.amountPerBuy > type(uint64).max || a.keeperReward > type(uint64).max || a.startAt > type(uint64).max
                || a.interval > type(uint32).max || a.maxBuys > type(uint16).max || a.maxSlippageBps > type(uint16).max
                || a.communityWindow > type(uint32).max || a.turnBuckets > type(uint8).max
        ) revert ArgOutOfRange();
        // forge-lint: disable-start(unsafe-typecast) — every width is checked just above.
        return abi.encodePacked(
            a.owner,
            a.tokenOut,
            a.pair,
            a.oraclePool,
            uint64(a.amountPerBuy),
            uint64(a.keeperReward),
            uint64(a.startAt),
            uint32(a.interval),
            uint16(a.maxBuys),
            uint16(a.maxSlippageBps),
            uint32(a.communityWindow),
            uint8(a.turnBuckets)
        );
        // forge-lint: disable-end(unsafe-typecast)
    }

    /// `encode`'s inverse. `data` must be `LENGTH` bytes; `read` always hands it exactly that.
    function decode(bytes memory data) internal pure returns (Args memory a) {
        // Each field is the top bytes of the word loaded at its offset. The last loads run past
        // the 117 bytes, into memory allocated after them; the shift discards those bytes.
        assembly ("memory-safe") {
            let p := add(data, 0x20)
            mstore(a, shr(96, mload(p)))
            mstore(add(a, 0x20), shr(96, mload(add(p, 20))))
            mstore(add(a, 0x40), shr(96, mload(add(p, 40))))
            mstore(add(a, 0x60), shr(96, mload(add(p, 60))))
            mstore(add(a, 0x80), shr(192, mload(add(p, 80))))
            mstore(add(a, 0xa0), shr(192, mload(add(p, 88))))
            mstore(add(a, 0xc0), shr(192, mload(add(p, 96))))
            mstore(add(a, 0xe0), shr(224, mload(add(p, 104))))
            mstore(add(a, 0x100), shr(240, mload(add(p, 108))))
            mstore(add(a, 0x120), shr(240, mload(add(p, 110))))
            mstore(add(a, 0x140), shr(224, mload(add(p, 112))))
            mstore(add(a, 0x160), shr(248, mload(add(p, 116))))
        }
    }

    /// The terms of the clone this code is running for, read from its code.
    function read() internal view returns (Args memory) {
        return decode(ClonesWithArgs.readArgs(LENGTH));
    }
}
