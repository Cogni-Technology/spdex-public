// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.33;

/// @title VaultLimits — the bounds every vault is held to
/// @notice Constants rather than terms, on purpose: a limit a plan could set for itself is not
///         a limit. The factory applies the ones that bound a plan when it creates a vault and
///         when it checks its market list; the vault applies the ones it needs at every buy.
///         Both inherit them from here, so each answers them itself and neither can disagree
///         with the other.
/// @dev `packages/vault/src/artifacts.ts` mirrors every value below as `VAULT_LIMITS`,
///      generated from this file.
abstract contract VaultLimits {
    /// The most a vault can ever hold for its plan: `maxBuys × (amountPerBuy +
    /// keeperReward)` may not exceed it. This is unaudited code, and the cap is what makes
    /// the worst case something a person can decide to accept.
    uint256 public constant MAX_FUNDING = 0.5 ether;
    /// The shortest interval, matching the app's own recurring buys.
    uint256 public constant MIN_INTERVAL = 300;
    /// The longest interval. Bounded so that every slot's start fits comfortably in
    /// 256 bits and the views can never overflow.
    uint256 public constant MAX_INTERVAL = 366 days;
    /// The loosest price floor a plan may choose: paying 5% more than the oracle's price.
    uint256 public constant MAX_SLIPPAGE_BPS = 500;
    /// A keeper's reward may be at most 0.69% of one buy, the network cost of making the buy
    /// included. It is the whole of what a buy pays anyone for being made, so nobody who
    /// triggers buys, or is named to be paid for one, spDEX's developers included, can ever
    /// be paid more than that by a vault from this factory. A buy too small for 0.69% of it
    /// to cover its gas is one a keeper makes at its own cost, or not at all.
    uint256 public constant MAX_REWARD_BPS = 69;
    /// The averaging window of the price floor, in seconds.
    uint256 public constant TWAP_WINDOW = 600;
    /// The least depth the oracle pool must have behind its price, as WETH: its
    /// harmonic-mean liquidity over the window, as a virtual WETH reserve. What a floor is
    /// worth is what it costs to move the average under it, and with this much depth a push
    /// big enough to matter costs more than the most a vault could ever lose to it: the
    /// whole budget is capped at 0.5 ETH. SPX's 0.3% pool had about 60 at the pinned block.
    uint256 public constant MIN_ORACLE_DEPTH = 10 ether;
    /// The least history the oracle pool must keep, in observations. Uniswap v3 writes at
    /// most one per block, so on mainnet's 12-second slots 51 always reach back ten minutes;
    /// 100 leaves room for blocks that come closer together than that, as a local fork's can.
    /// SPX's 0.3% pool keeps 1,800.
    uint256 public constant MIN_OBSERVATIONS = 100;
    /// The most buys a plan can have.
    uint256 public constant MAX_BUYS = 1_000;
    /// How far from now `startAt` may be, either way. A start years out is a typo, and a
    /// start years back is one too.
    uint256 public constant MAX_START_DRIFT = 366 days;
    /// The shortest community window a plan may have: a minute, five of mainnet's 12-second
    /// slots. Every plan has one (a window of zero is not allowed), and one shorter than this
    /// would give holders first claim in name only: a keeper that saw the buy fall due in one
    /// block could not count on landing it before the window closed.
    uint256 public constant MIN_COMMUNITY_WINDOW = 60;
    /// The longest community window: an hour. The factory also holds a window to a quarter
    /// of its plan's interval, so that, with the half-interval spacing, every window ends
    /// inside the slot it started in and leaves the rest of that slot open to anyone. A
    /// buy nobody eligible makes waits at most this long for the open fallback.
    uint256 public constant MAX_COMMUNITY_WINDOW = 1 hours;
    /// The most turns a plan's community window can be shared out in. A plan with turns
    /// (`turnBuckets`, 2 to this) gives the first half of each window to the eligible
    /// addresses that fall in that buy's bucket, so a bot that wants first claim on every buy
    /// needs a proven address in every bucket; one 690 SPX, moved into each at its buy, can
    /// serve them all. Zero turns, which every vault
    /// the app creates has until decision 29 of `docs/V2_UPGRADE.md` calls for them, is the
    /// race v2 launched with.
    uint256 public constant MAX_TURN_BUCKETS = 64;
}
