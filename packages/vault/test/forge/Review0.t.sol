// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.33;

import {ForkTest, Plan} from "./utils/Fork.sol";
import {SpdexDcaVault} from "../../contracts/SpdexDcaVault.sol";

/// Review regression: the buy-timing arithmetic at its exact edges — one buy per window, and
/// at least half an interval between two buys.
contract Review0Test is ForkTest {
    function test_review_windowEdges() public {
        Plan memory t = defaultPlan();
        t.startAt = block.timestamp + 1000;
        SpdexDcaVault vault = createFunded(t);

        vm.warp(t.startAt - 1);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SpdexDcaVault.NotStarted.selector, t.startAt));
        vault.execute(keeper);
        (bool due, uint256 nextBuyAt,,,,,,,) = vault.status();
        assertTrue(!due && nextBuyAt == t.startAt, "one second early: not due, due at startAt");

        // The first second of window 0.
        vm.warp(t.startAt);
        vm.prank(keeper);
        vault.execute(keeper);
        (due, nextBuyAt,,,,,,,) = vault.status();
        assertTrue(!due && nextBuyAt == t.startAt + t.interval, "next due at window 1's first second");

        // The last second of window 1: long enough after the first buy, so allowed.
        vm.warp(t.startAt + 2 * t.interval - 1);
        vm.prank(keeper);
        vault.execute(keeper);
        (due, nextBuyAt,,,,,,,) = vault.status();
        uint256 spaced = t.startAt + 2 * t.interval - 1 + t.interval / 2;
        assertTrue(
            !due && nextBuyAt == spaced, "window 2 opens a second later, but the next buy waits half an interval"
        );

        // One second before, and exactly at, half an interval after the last buy.
        vm.warp(spaced - 1);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SpdexDcaVault.TooSoon.selector, spaced));
        vault.execute(keeper);
        vm.warp(spaced);
        vm.prank(keeper);
        vault.execute(keeper);
        assertEq(vault.lastBuyAt(), spaced, "the third buy, in window 2");

        // Far ahead: one buy, then nothing until the window after the one it used.
        vm.warp(t.startAt + 7 * t.interval + 5);
        vm.prank(keeper);
        vault.execute(keeper);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(SpdexDcaVault.TooSoon.selector, t.startAt + 8 * t.interval));
        vault.execute(keeper);
        assertEq(vault.buysDone(), 4, "four buys");
    }
}
