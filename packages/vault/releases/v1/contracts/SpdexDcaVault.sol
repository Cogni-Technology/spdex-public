// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.33;

import {IERC20Minimal, IUniswapV2PairMinimal, IUniswapV3OracleMinimal, IWETH9} from "./interfaces/External.sol";
import {OracleQuote} from "./libraries/OracleQuote.sol";
import {Args, VaultArgs} from "./libraries/VaultArgs.sol";
import {VaultLimits} from "./VaultLimits.sol";

/// @notice One auto-buy plan's terms, as `terms()` returns them and `VaultCreated` announces
///         them. Every field is fixed for the life of the vault.
/// @dev Every number is a uint256 so that one TypeScript type (bigint) covers them all; the
///      factory, not the ABI, is what bounds them.
struct Terms {
    /// The token bought. Paid for with WETH, always.
    address tokenOut;
    /// The Uniswap v2 WETH/tokenOut pair every buy trades on.
    address pair;
    /// The Uniswap v3 WETH/tokenOut pool whose 10-minute average sets each buy's price floor.
    address oraclePool;
    /// WETH (wei) spent on each buy.
    uint256 amountPerBuy;
    /// Seconds between buy windows.
    uint256 interval;
    /// How many buys, at most. The vault can never spend more than
    /// `maxBuys × (amountPerBuy + keeperReward)`, and that is capped at `MAX_FUNDING`.
    uint256 maxBuys;
    /// When the first window opens (unix seconds, chain time).
    uint256 startAt;
    /// WETH (wei) paid to whoever triggers a buy, from the vault's balance.
    uint256 keeperReward;
    /// The most a buy may pay above the oracle's price, in basis points: the better, for the
    /// owner, of the pool's 10-minute average and its price now.
    uint256 maxSlippageBps;
}

/// @title SpdexDcaVault — one auto-buy plan that runs with no spDEX page open
/// @author spDEX
/// @notice UNAUDITED. Funding stops at 0.5 ETH: neither creation nor `fund` takes the budget
///         past it. Only the owner can withdraw, and nobody — not spDEX, not the factory, not
///         whoever triggers a buy — can change the terms or take the funds.
///
///         The cap bounds what the owner can put in, not what a vault can hold: anyone can
///         send one WETH, and ether or WETH sent to its address before it exists is there
///         when it appears. `close` returns all of it to the owner.
///
/// ## Why a contract, and why this shape
///
/// A contract cannot wake itself up; something has to send a transaction. So the "server
/// of sorts" an auto-buy needs while no page is open is not a server at all. It is a
/// contract that holds the plan's budget and *enforces the plan itself*, so that it does
/// not matter who sends the transaction. The caller chooses only *when* — and only inside
/// a window that is due — never how much, what, where to, or at what price. Once funded,
/// no outside party ever signs for the owner's money: not spDEX, not a keeper, not a bot.
///
/// That is why `execute` is open to anyone and pays a small fixed reward. The reward makes
/// triggering worth someone's while; it does not make anyone do it. A plan runs while
/// somebody runs a keeper — `pnpm keeper`, an open spDEX tab's "Trigger now", or a
/// stranger's bot that finds the reward worth its gas — and a window nobody triggers is
/// skipped. None of them needs the owner's trust, and the owner needs none of theirs,
/// because a buy that breaks any term reverts. A keeper that makes many vaults' buys in
/// one transaction does it through `SpdexVaultBatcher`, which is one more caller of
/// `execute` with no rights a direct caller lacks.
///
/// The Guard's promise moves on chain with it. The app refuses a swap that pays far more
/// than a time-weighted price says it should; this vault refuses any buy that pays more
/// than `maxSlippageBps` above a Uniswap v3 pool's price for the pair — the better, for the
/// owner, of its 10-minute average and its price now. The average is the same kind of
/// reference the app's oracle cross-check reads; the price now is there because an average
/// lags, and a market that has just fallen back should not be bought at the stale average
/// less the allowance.
///
/// ## One contract, many clones
///
/// This contract is deployed once, by the factory, and never holds a plan itself. Each
/// vault is a clone of it: a 45-byte EIP-1167 proxy that delegates every call here, with
/// the plan's terms appended to the clone's own code (`libraries/VaultArgs.sol` has the
/// layout). A full contract per plan cost about 2.3 million gas to create; a clone costs
/// about 148,000 (measured on the fork: `test/integration/vault.test.ts`). Each call pays
/// for it with about 5,000 more gas: the proxy, a `delegatecall` here, and reading the
/// terms back.
///
/// The terms live in the clone's *code* rather than its storage for the same reason they
/// were `immutable` before: nothing can write code after it is deployed. There is no
/// initializer — the creating transaction writes the terms into the clone as it deploys
/// it — so there is no moment at which a clone exists without its terms, and nothing for
/// anyone to call first. Every call reads them back once, with `EXTCODECOPY` of its own
/// address: under `delegatecall` that address is the clone, whose code carries them,
/// while `CODECOPY` would read this contract's code, which does not.
///
/// This contract itself refuses every call that concerns a plan (`NotAClone`): it has no
/// terms, and someone who mistook it for a vault should be told so rather than answered
/// with zeros. What it does still answer — its limits and `weth` — is true of every clone.
///
/// ## What it deliberately does not do
///
/// - **No admin, no upgrade, no pause switch held by anyone else, no fee.** The terms are
///   part of the clone's code and the implementation's address is part of the proxy, so a
///   vault's behaviour is fixed the moment it exists. The one way to stop a plan is
///   `close`, which returns everything to the owner; there is no pause because a pause is
///   a switch, and a switch is a thing someone has to be trusted with.
/// - **No make-up buys, and no two buys close together.** Time is cut into windows of
///   `interval` seconds from `startAt`, each window allows at most one buy, and a buy must
///   also come at least half an interval after the last. A window nobody triggered is
///   skipped, never made up later: a catch-up burst defeats the averaging and is exactly
///   what someone able to delay keepers would want to provoke. The spacing is there so that
///   one push of the price cannot cover the last second of one window and the first of the
///   next.
/// - **It never holds the token it buys.** Each swap pays out straight to the owner, and
///   the vault checks the owner received every unit the pair sent — so a fee-on-transfer
///   token is refused outright, even when its fee would fit inside the price floor.
/// - **It pays keepers in WETH**, never with a raw ether call to an unknown address, so
///   the one party that may be anyone cannot run code in the middle of a buy.
///
/// ## What it trusts, and what it checks
///
/// Nobody chooses a vault's market when creating it. The factory was deployed with a fixed
/// list of markets — a token, the Uniswap v2 pair it trades on and the Uniswap v3 pool its
/// floor is read from — and a plan names an entry in that list, nothing else. The factory
/// checked each entry once, at its own deployment: the pair and the pool are the ones
/// Uniswap's own factories list for WETH and that token, the pool keeps at least
/// `MIN_OBSERVATIONS` of history (fewer, and one trade can overwrite it and leave the pool
/// unable to answer a ten-minute average for the next ten minutes), it has at least
/// `MIN_ORACLE_DEPTH` of depth behind its price, and its average agrees with the pair's mid
/// price. Another list means another factory, at another address. So an impostor pair or
/// pool, or an empty or forgetful one, cannot be given to a vault the factory vouches for —
/// which is what the phase-5a reviews showed an open choice allowed.
///
/// Those checks vet markets, not tokens. A token whose own code was written to trap a
/// keeper passes every one of them once it has a genuine pair and a genuine, deep pool with
/// history (`test_r5b_aKeeperTrapTokenWithGenuineMarketsPassesEveryListingCheck`): no check
/// a contract can make tells hostile code from honest. Tokens are vetted by hand, by whoever
/// writes a list — mainnet's is SPX alone, whose transfer calls nobody — and the factory's
/// address pins what they chose.
///
/// Depth can leave after the list is fixed, so it is checked again at every buy (and
/// `status` reports it): the pool's harmonic-mean liquidity over the same ten minutes, as
/// WETH. Any stretch of the window the price spent where nobody provides liquidity drags it
/// towards zero, so a pool that could be moved for free is refused rather than believed.
///
/// The agreement between pool and pair is not checked again. A vault that refused to buy
/// while they disagreed could be refused by anyone willing to move the pair in the same
/// block, so a buy is judged against the pool alone, as the floor always is. While the two
/// disagree the floor is that much stricter against the pair when the pool quotes more
/// tokens per WETH — buys whose allowance is smaller wait — and that much looser when it
/// quotes fewer, and buys go ahead
/// (`test_r5b_buysContinueWhileThePoolAndPairDisagreeBeyondTheListingGap`).
///
/// What that check cannot see is how the depth is spread. A pool whose only liquidity is one
/// narrow position has a large depth at that one price for very little money, so whoever
/// owns that position sets the price. That is why the list names its pool by hand — for SPX
/// the 0.3% pool, which holds SPX's v3 liquidity across the range — rather than letting any
/// live measure pick one, and why these checks refuse empty, thin and forgetful markets
/// rather than prove a market sound.
///
/// A clone made by hand, outside the factory, carries whatever terms its maker wrote into
/// it, and nothing checks them. The factory's `isVault` is how the app and a keeper tell its
/// vaults from those, and neither trusts a vault it does not vouch for.
///
/// ## What a hostile keeper can do
///
/// Choose the moment within a due window, and sandwich the buy: push the v2 price up to
/// just inside the floor, let the buy land, sell back. The floor is `maxSlippageBps` (at
/// most 5%, `MAX_SLIPPAGE_BPS`) below the better of the pool's average and its price now,
/// so that is what it can cost the owner — plus however far the pair sits below the pool
/// in price, which is the real market having moved in the owner's favour before the pool
/// followed, or someone having moved the pair.
///
/// Whether a sandwich pays is another matter: the front-run pays the pair's 0.3% fee going
/// in and coming out. At the pinned block SPX's pair holds about 2,500 WETH, and sandwiching
/// the largest buy the cap allows (0.45 ETH on a 5% floor) left the sandwicher about 0.29
/// ETH down, reward included (`test_sandwichingTheLargestAllowedSpxBuyLosesMoney`).
/// Break-even is a buy of about 0.3% of the pair's WETH, so `maxSlippageBps` only binds for
/// pairs holding under about 170 WETH; above that, the pair's own fee is the protection.
///
/// Moving the average is the other lever, and the pool is much thinner than the pair: SPX's
/// 0.3% pool held about 30 WETH and 254,000 SPX at that block. Holding it 16,000 ticks off
/// across one block boundary (12 seconds) moves the average by about 3.25%, enough to refuse
/// every buy on a 3% floor for ten minutes; it costs about 0.17 ETH to a searcher who holds
/// both block positions, and about 18 ETH if an arbitrageur takes the reversal
/// (`test_oneBlockOnTheOraclePoolRefusesEveryBuyForTenMinutes`). The same push the other
/// way lowers the floor for those ten minutes, which pays only through a sandwich on the
/// deep pair, above. So on SPX the realistic harm is skipped windows, not lost funds.
///
/// The cheapest lever refuses one buy, not ten minutes of them. The floor takes the better,
/// for the owner, of the average and the pool's price now, so pushing the price now the
/// owner's way — SPX into the pool — raises the floor inside the same block, with no block
/// boundary to hold, and anyone who orders transactions around a public `execute` can push
/// before it and swap back after. At the pinned block, refusing a buy on a 3% floor takes
/// about 275 ticks, about 0.75 WETH through the pool, and costs about 0.0045 ETH for the
/// round trip: the pool's fee both ways
/// (`test_pushingThePoolsPriceNowRefusesABuyForItsFeesAlone`). It moves none of the owner's
/// money, and the same window buys once the push is undone; but a keeper that takes the
/// early refusal as "wait for the next window" loses that window, and the owner that buy
/// time. (`pnpm keeper` tries a refused vault again ten minutes later, at most twice a
/// window, so as not to pay for the same refusal without end.)
///
/// It cannot redirect the output, buy twice in a window, or spend more than one buy's
/// worth plus its reward.
contract SpdexDcaVault is VaultLimits {
    uint256 private constant BPS = 10_000;

    // ─── Shared by every clone ───────────────────────────────────────────────────
    // Immutables are part of this contract's code, which every clone runs, so they are the
    // same for all of them; each clone's own terms are in its code (see `VaultArgs`).

    /// The WETH every vault pays with.
    IWETH9 public immutable weth;
    /// This contract's own address. Under a clone's `delegatecall`, `address(this)` is the
    /// clone; only a call made to this contract directly sees the two equal.
    address private immutable self;

    // ─── State ───────────────────────────────────────────────────────────────────
    // Each clone's own storage. Packed into one slot: every buy writes both counters, and
    // one storage write is a real share of a small buy's gas. `buysDone` never exceeds
    // MAX_BUYS; a timestamp fits 64 bits for billions of years.

    uint32 private _buysDone;
    uint64 private _lastBuyAt;
    bool private _closed;
    uint256 private _totalOut;

    /// The reentrancy lock, in transient storage: it only has to hold for one transaction,
    /// so it costs a fraction of a storage slot and cannot be left stuck. Like storage, it
    /// is the clone's own.
    bool private transient locked;

    // ─── Events ──────────────────────────────────────────────────────────────────

    event Funded(uint256 amount);
    /// One buy, with what it was judged against, so that a buy's quality and a plan's history
    /// can be read from its logs alone. `floorOut` and `oracleDepth` are the floor and the
    /// oracle pool's depth this buy was checked against (`quote()` at that moment);
    /// `buyNumber` counts this vault's buys from 1, so a gap in it is a log someone's
    /// endpoint dropped, which `slot` cannot show because windows legitimately go unbought.
    event Bought(
        uint256 indexed slot,
        uint256 amountIn,
        uint256 amountOut,
        address indexed keeper,
        uint256 reward,
        uint256 floorOut,
        uint256 buyNumber,
        uint256 oracleDepth
    );
    event Closed(uint256 amount);
    event Rescued(address indexed token, uint256 amount);

    // ─── Errors ──────────────────────────────────────────────────────────────────
    // Named, with the figures that decided them, so a keeper or the app can say why a call
    // was refused without guessing from a string. The terms' own refusals are the factory's.

    error NotAClone();
    error Unauthorized();
    error Reentrancy();
    error VaultClosed();
    error NothingToFund();
    error FullyFunded();
    error RefundFailed();
    error NotStarted(uint256 startAt);
    error TooSoon(uint256 nextBuyAt);
    error NoBuysLeft();
    error InsufficientBalance(uint256 balance, uint256 needed);
    error OracleTooThin(uint256 depth, uint256 minimum);
    error PriceBelowFloor(uint256 spotOut, uint256 floorOut);
    error DeliveredShort(uint256 received, uint256 sent);
    error WethLockedUntilClosed();
    error TransferFailed(address token);
    error OnlyWeth();

    /// Every function that changes state takes the lock, so a token, pair or owner contract
    /// that calls back mid-transaction finds every door shut rather than only some.
    modifier nonReentrant() {
        if (locked) revert Reentrancy();
        locked = true;
        _;
        locked = false;
    }

    /// @dev Deployed by `SpdexVaultFactory`'s constructor, once. Nothing here is a plan's:
    ///      each clone's terms are written into its code by `createVault`.
    constructor(address weth_) {
        weth = IWETH9(weth_);
        self = address(this);
    }

    // ─── Owner ───────────────────────────────────────────────────────────────────

    /// @notice Add to the budget, in ether; it is held as WETH. Anything beyond what the
    ///         remaining buys and their rewards still need is sent straight back.
    /// @dev The factory capped that need at MAX_FUNDING, so this is also the hard cap:
    ///      `fund` never takes the vault's WETH above either. (A plain WETH transfer can —
    ///      anyone may send the vault tokens — and `close` returns that to the owner too.)
    ///      It returns the excess rather than refusing it because the room is not the
    ///      caller's to know exactly: a wei of WETH sent to the vault by anyone just before
    ///      this call would otherwise make an owner's exact funding revert, every time.
    function fund() external payable nonReentrant {
        Args memory a = _terms();
        if (msg.sender != a.owner) revert Unauthorized();
        if (_closed) revert VaultClosed();
        if (msg.value == 0) revert NothingToFund();
        uint256 need = (a.maxBuys - _buysDone) * (a.amountPerBuy + a.keeperReward);
        uint256 balance = weth.balanceOf(address(this));
        if (balance >= need) revert FullyFunded();
        uint256 accepted = msg.value < need - balance ? msg.value : need - balance;

        weth.deposit{value: accepted}();
        emit Funded(accepted);
        // The caller is the owner (checked above), and the lock is held, so this call can
        // only return the owner's own ether to them.
        if (accepted < msg.value) {
            (bool sent,) = msg.sender.call{value: msg.value - accepted}("");
            if (!sent) revert RefundFailed();
        }
    }

    /// @notice Stop the plan for good and send everything it holds to the owner as ether.
    /// @dev The only stop there is. If the owner cannot receive ether (a contract that
    ///      refuses it), the same amount goes as WETH instead: never stranded. Callable
    ///      again after closing, to sweep anything that arrived since.
    function close() external nonReentrant {
        Args memory a = _terms();
        if (msg.sender != a.owner) revert Unauthorized();
        _closed = true;

        uint256 wrapped = weth.balanceOf(address(this));
        if (wrapped != 0) weth.withdraw(wrapped);
        uint256 amount = address(this).balance;
        if (amount != 0) {
            (bool sent,) = a.owner.call{value: amount}("");
            if (!sent) {
                weth.deposit{value: amount}();
                _transfer(address(weth), a.owner, amount);
            }
        }
        emit Closed(amount);
    }

    /// @notice Send the owner any ERC-20 this vault holds by mistake.
    /// @dev WETH is the budget, so it only comes out this way once the vault is closed;
    ///      until then `close` is the way to get it back.
    function rescue(address token) external nonReentrant {
        Args memory a = _terms();
        if (msg.sender != a.owner) revert Unauthorized();
        if (token == address(weth) && !_closed) revert WethLockedUntilClosed();
        uint256 amount = IERC20Minimal(token).balanceOf(address(this));
        _transfer(token, a.owner, amount);
        emit Rescued(token, amount);
    }

    // ─── Anyone ──────────────────────────────────────────────────────────────────

    /// @notice Make this window's buy, if it is due, and be paid `keeperReward` in WETH.
    /// @return received What the owner actually received, measured at the owner.
    /// @dev The caller decides only when. Everything else — the amount, the token, the
    ///      recipient, the floor — is fixed by the terms and checked here.
    function execute() external nonReentrant returns (uint256 received) {
        Args memory a = _terms();
        if (_closed) revert VaultClosed();
        if (block.timestamp < a.startAt) revert NotStarted(a.startAt);
        {
            uint256 nextBuyAt = _nextBuyAt(a);
            if (block.timestamp < nextBuyAt) revert TooSoon(nextBuyAt);
        }
        if (_buysDone >= a.maxBuys) revert NoBuysLeft();
        {
            uint256 needed = a.amountPerBuy + a.keeperReward;
            uint256 balance = weth.balanceOf(address(this));
            if (balance < needed) revert InsufficientBalance(balance, needed);
        }

        // Effects before anything leaves the vault: this window is used, whatever follows.
        // Timestamps fit 64 bits for longer than the sun will shine.
        // forge-lint: disable-next-line(unsafe-typecast)
        _lastBuyAt = uint64(block.timestamp);
        uint256 buyNumber = ++_buysDone;

        // The floor comes from the pool: its 10-minute average, which a swap in this block
        // cannot move, or its price now if that is better for the owner, which a swap can
        // only make stricter. The amount out comes from the pair's reserves right now. The
        // pool must still have depth behind its price, or its average is anyone's to set.
        // The floor and the depth are kept for `Bought`, which reports what the buy was
        // judged against.
        (uint256 floorOut, uint256 depth) = _floor(a);
        if (depth < MIN_ORACLE_DEPTH) revert OracleTooThin(depth, MIN_ORACLE_DEPTH);
        uint256 spotOut = _spotOut(a);
        if (spotOut < floorOut) revert PriceBelowFloor(spotOut, floorOut);

        // Pay the pair and have it pay the owner directly. The reserves were read in this
        // same call, so the amount out is exactly what the pair's invariant allows.
        uint256 before = IERC20Minimal(a.tokenOut).balanceOf(a.owner);
        _transfer(address(weth), a.pair, a.amountPerBuy);
        (uint256 out0, uint256 out1) = _wethIsToken0(a) ? (uint256(0), spotOut) : (spotOut, uint256(0));
        IUniswapV2PairMinimal(a.pair).swap(out0, out1, a.owner, "");

        // Measured, not assumed: a token that takes a fee on transfer, or lies about the
        // amount, delivers less than the pair sent, and that must fail here rather than
        // count as a buy — whether or not the shortfall would fit inside the floor, since a
        // floor is an allowance for the market, not for the token.
        uint256 afterward = IERC20Minimal(a.tokenOut).balanceOf(a.owner);
        received = afterward > before ? afterward - before : 0;
        if (received < spotOut) revert DeliveredShort(received, spotOut);

        // Written after the swap because it is only known after it; the lock above is what
        // keeps a callback from observing or changing anything in between.
        _totalOut += received;
        if (a.keeperReward != 0) _transfer(address(weth), msg.sender, a.keeperReward);
        emit Bought(
            (block.timestamp - a.startAt) / a.interval,
            a.amountPerBuy,
            received,
            msg.sender,
            a.keeperReward,
            floorOut,
            buyNumber,
            depth
        );
    }

    // ─── Views ───────────────────────────────────────────────────────────────────

    /// @notice Who owns this vault: the account that created it, the only one that can fund,
    ///         close or rescue.
    function owner() external view returns (address) {
        return _terms().owner;
    }

    /// @notice The terms, exactly as created.
    function terms() external view returns (Terms memory) {
        Args memory a = _terms();
        return Terms({
            tokenOut: a.tokenOut,
            pair: a.pair,
            oraclePool: a.oraclePool,
            amountPerBuy: a.amountPerBuy,
            interval: a.interval,
            maxBuys: a.maxBuys,
            startAt: a.startAt,
            keeperReward: a.keeperReward,
            maxSlippageBps: a.maxSlippageBps
        });
    }

    /// @notice Buys made so far.
    function buysDone() external view returns (uint32) {
        _notTheImplementation();
        return _buysDone;
    }

    /// @notice When the last buy was made, chain time; 0 before the first. Its window, and
    ///         the earliest the next buy may come, both follow from it.
    function lastBuyAt() external view returns (uint64) {
        _notTheImplementation();
        return _lastBuyAt;
    }

    /// @notice Set by `close`. A closed vault cannot be funded or execute a buy.
    function closed() external view returns (bool) {
        _notTheImplementation();
        return _closed;
    }

    /// @notice Everything delivered to the owner so far, in `tokenOut`'s raw units, as
    ///         measured at the owner. With `buysDone` it gives a UI the average price
    ///         without reading logs.
    function totalOut() external view returns (uint256) {
        _notTheImplementation();
        return _totalOut;
    }

    /// @notice Everything a keeper or a page needs to decide cheaply whether `execute` would
    ///         pass, except the price, which is `quote`'s.
    /// @dev The oracle pool's depth is part of `due` because it is not a moment's question:
    ///      once liquidity leaves a pool, every buy is refused until it comes back, and a
    ///      status that went on saying "due" would have every reader offer a trigger that can
    ///      only revert. The price floor is left to `quote` because it is: it changes with
    ///      every trade on the pair, and "due, but the price is outside the floor" is worth
    ///      saying as such. The pool is read inside a `try`, so a pool that cannot answer a
    ///      ten-minute average right now makes the buy not due rather than this unreadable.
    /// @return due Every check `execute` makes except the price floor passes right now: not
    ///         closed, a buy left, the window open and the last buy far enough back, the
    ///         budget there, and the oracle pool answering with at least `MIN_ORACLE_DEPTH`.
    /// @return nextBuyAt The earliest moment the next buy may happen, by the clock alone
    ///         (at or before now when `due`; possibly so while not due, for want of budget or
    ///         depth); 0 when none will.
    /// @return buysLeft Buys the plan has left; 0 once closed.
    /// @return wethBalance The WETH held, in wei. Anyone can send a vault WETH, so this can
    ///         exceed what the plan needs, and even `MAX_FUNDING`; `close` returns all of it.
    /// @return funded Whether that covers the next buy and its reward.
    function status()
        external
        view
        returns (bool due, uint256 nextBuyAt, uint256 buysLeft, uint256 wethBalance, bool funded)
    {
        Args memory a = _terms();
        wethBalance = weth.balanceOf(address(this));
        funded = wethBalance >= a.amountPerBuy + a.keeperReward;
        buysLeft = _closed ? 0 : a.maxBuys - _buysDone;
        if (buysLeft == 0) return (false, 0, 0, wethBalance, funded);

        nextBuyAt = _nextBuyAt(a);
        // The pool last, and only when everything else says yes: it is the one read here
        // that costs real gas.
        due = funded && block.timestamp >= nextBuyAt && _oracleDeepEnough(a);
    }

    /// @notice What a buy would deliver now, the least it may deliver, and the depth of the
    ///         market the floor comes from.
    /// @return spotOut From the pair's reserves right now, after its 0.3% fee.
    /// @return floorOut The better, for the owner, of the pool's 10-minute average price
    ///         and its price now, less `maxSlippageBps`.
    /// @return oracleDepth The pool's harmonic-mean liquidity over the window, as WETH.
    /// @dev `execute` makes the buy exactly when `oracleDepth >= MIN_ORACLE_DEPTH` and
    ///      `spotOut >= floorOut`. Reverts if the pool cannot answer a 10-minute average at
    ///      this moment.
    function quote() external view returns (uint256 spotOut, uint256 floorOut, uint256 oracleDepth) {
        Args memory a = _terms();
        (floorOut, oracleDepth) = _floor(a);
        spotOut = _spotOut(a);
    }

    /// @notice Rewards paid to keepers so far, in wei. Every buy pays the same reward, so
    ///         this is derived rather than stored.
    function totalRewards() external view returns (uint256) {
        return uint256(_buysDone) * _terms().keeperReward;
    }

    // ─── Internals ───────────────────────────────────────────────────────────────

    /// This clone's terms, read once from its code; refuses on the implementation itself,
    /// which has none. Every entry point that concerns a plan starts here.
    function _terms() private view returns (Args memory) {
        _notTheImplementation();
        return VaultArgs.read();
    }

    function _notTheImplementation() private view {
        if (address(this) == self) revert NotAClone();
    }

    /// Whether WETH is token0 in both the pair and the pool. Both Uniswap versions order a
    /// pair's tokens by address, and the factory checked both are Uniswap's own.
    function _wethIsToken0(Args memory a) private view returns (bool) {
        return address(weth) < a.tokenOut;
    }

    /// Uniswap v2's amount out for `amountPerBuy` WETH, with its 0.3% fee.
    function _spotOut(Args memory a) private view returns (uint256) {
        (uint112 reserve0, uint112 reserve1,) = IUniswapV2PairMinimal(a.pair).getReserves();
        (uint256 reserveIn, uint256 reserveOut) =
            _wethIsToken0(a) ? (uint256(reserve0), uint256(reserve1)) : (uint256(reserve1), uint256(reserve0));
        if (reserveIn == 0 || reserveOut == 0) return 0;
        uint256 inWithFee = a.amountPerBuy * 997;
        return (inWithFee * reserveOut) / (reserveIn * 1000 + inWithFee);
    }

    /// `amountPerBuy` WETH at the better of the pool's 10-minute mean tick and its tick now,
    /// less the plan's slippage allowance; and the pool's depth over the same window.
    function _floor(Args memory a) private view returns (uint256 floorOut, uint256 depth) {
        bool wethIsToken0 = _wethIsToken0(a);
        // forge-lint: disable-next-line(unsafe-typecast) — a constant 600 fits 32 bits.
        (int24 meanTick, uint256 liquidity) = OracleQuote.consult(a.oraclePool, uint32(TWAP_WINDOW));
        depth = OracleQuote.wethDepth(meanTick, liquidity, wethIsToken0);

        // "Better" is more tokenOut per WETH. A pool's price is token1 per token0, so that is
        // the higher tick when WETH is token0 and the lower one when it is token1. Whoever
        // calls can move the tick now within this transaction, but only towards refusing:
        // below the average, the average is used.
        (, int24 nowTick,,,,,) = IUniswapV3OracleMinimal(a.oraclePool).slot0();
        int24 tick = (wethIsToken0 == (nowTick > meanTick)) ? nowTick : meanTick;

        // amountPerBuy <= MAX_FUNDING (checked at creation), so it fits a uint128.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint256 fair = OracleQuote.quoteAtTick(tick, uint128(a.amountPerBuy), address(weth), a.tokenOut);
        floorOut = (fair * (BPS - a.maxSlippageBps)) / BPS;
    }

    /// Whether the oracle pool answers a ten-minute average with the depth `execute` requires,
    /// without reverting when it cannot answer at all. `execute` makes the same check through
    /// `_floor`, reverting.
    function _oracleDeepEnough(Args memory a) private view returns (bool) {
        // forge-lint: disable-next-line(unsafe-typecast) — a constant 600 fits 32 bits.
        (bool answered, int24 meanTick, uint256 liquidity) = OracleQuote.tryConsult(a.oraclePool, uint32(TWAP_WINDOW));
        return answered && OracleQuote.wethDepth(meanTick, liquidity, _wethIsToken0(a)) >= MIN_ORACLE_DEPTH;
    }

    /// The earliest moment the next buy may happen: `startAt` before the first; after it,
    /// the start of the window after the last buy's or half an interval after the last buy,
    /// whichever is later.
    function _nextBuyAt(Args memory a) private view returns (uint256) {
        uint256 last = _lastBuyAt;
        if (last == 0) return a.startAt;
        uint256 nextWindow = a.startAt + ((last - a.startAt) / a.interval + 1) * a.interval;
        uint256 spaced = last + a.interval / 2;
        return nextWindow > spaced ? nextWindow : spaced;
    }

    /// An ERC-20 transfer that also accepts tokens returning nothing, and refuses one that
    /// returns false or is not a contract at all.
    function _transfer(address token, address to, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(abi.encodeCall(IERC20Minimal.transfer, (to, amount)));
        if (!ok || (data.length == 0 ? token.code.length == 0 : !abi.decode(data, (bool)))) {
            revert TransferFailed(token);
        }
    }

    /// Ether arrives only from WETH, when `close` unwraps the budget. Anything else sent
    /// here is refused so that it bounces back to its sender instead of sitting unwrapped;
    /// the way to add to the budget is `fund`.
    /// @dev WETH sends it with `transfer`'s 2,300-gas stipend. Through a clone that pays for
    ///      the proxy and a `delegatecall` here as well, which fits because this contract is
    ///      already warm in the transaction that called `close`
    ///      (`test_closeReturnsEverythingAsEtherThenNothingElseWorks` proves it).
    receive() external payable {
        _notTheImplementation();
        if (msg.sender != address(weth)) revert OnlyWeth();
    }
}
