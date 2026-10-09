// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.33;

import {IERC20Minimal, IUniswapV2PairMinimal, IUniswapV3OracleMinimal, IWETH9} from "./interfaces/External.sol";
import {ISpxHolderRegistry} from "./interfaces/ISpxHolderRegistry.sol";
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
    /// Seconds between buy slots: each slot allows one buy.
    uint256 interval;
    /// How many buys, at most. The vault can never spend more than
    /// `maxBuys × (amountPerBuy + keeperReward)`, and that is capped at `MAX_FUNDING`.
    uint256 maxBuys;
    /// When the first slot opens (unix seconds, chain time).
    uint256 startAt;
    /// WETH (wei) paid for each buy, from the vault's balance, to the `rewardTo` whoever made
    /// the buy named.
    uint256 keeperReward;
    /// The most a buy may pay above the oracle's price, in basis points: the better, for the
    /// owner, of the pool's 10-minute average and its price now.
    uint256 maxSlippageBps;
    /// Seconds after each buy falls due during which its fee can be paid only to the owner
    /// or to an address the SPX holder registry finds eligible: the community window.
    uint256 communityWindow;
    /// How many turns the window's first half is shared out in: 0 for none, the race every
    /// eligible holder runs for the whole window; else 2 to `MAX_TURN_BUCKETS`, and for the
    /// first half only the eligible addresses in each buy's bucket may be paid (see "Turns").
    uint256 turnBuckets;
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
/// not matter who sends the transaction. The caller chooses *when* — and only inside a
/// slot that is due — and who receives the caller's own fee (`rewardTo`), never how much,
/// what, where to, or at what price. Once funded, no outside party ever signs for the
/// owner's money: not spDEX, not a keeper, not a bot.
///
/// That is why `execute` is open to anyone and pays a small fixed reward. The reward makes
/// triggering worth someone's while; it does not make anyone do it. A plan runs while
/// somebody runs a keeper — `pnpm keeper`, an open spDEX tab's "Help run the network" or
/// "Trigger now", or a stranger's bot that finds the reward worth its gas — and a slot
/// nobody triggers is skipped. None of them needs the owner's trust, and the owner needs
/// none of theirs, because a buy that breaks any term reverts. A keeper that makes many
/// vaults' buys in one transaction does it through `SpdexVaultBatcher`, which is one more
/// caller of `execute` with no rights a direct caller lacks.
///
/// The Guard's promise moves on chain with it. The app refuses a swap that pays far more
/// than a time-weighted price says it should; this vault refuses any buy that pays more
/// than `maxSlippageBps` above a Uniswap v3 pool's price for the pair — the better, for the
/// owner, of its 10-minute average and its price now. The average is the same kind of
/// reference the app's oracle cross-check reads; the price now is there because an average
/// lags, and a market that has just fallen back should not be bought at the stale average
/// less the allowance.
///
/// ## Who is paid, and the community window
///
/// `execute` takes one argument, `rewardTo`: who receives the fee for this buy. It is the
/// only thing about a buy its caller names, and it names nothing about the buy itself —
/// the amount, the token, who receives what is bought, the market and the floor are the
/// terms', exactly as they would be for any other `rewardTo`
/// (`testFuzz_anyTwoAcceptedRewardTosMakeTheSameBuy`). v1 paid the caller instead; naming
/// the recipient is what lets the vault check who is paid rather than who sent the
/// transaction, so a keeper can sign with a hot key and be paid in a cold wallet, and a
/// batcher in the middle no longer hides the real recipient.
///
/// For the first `communityWindow` seconds after a buy falls due, `rewardTo` must be the
/// owner or an address the SPX holder registry (`registry`) finds eligible: an account, not
/// a contract, proven to have held at least 690 SPX at the end of a recent block, that holds
/// that much now. After the window, any address, as in v1. So the people who hold SPX and
/// run a keeper, or a spDEX tab, get first claim on every buy's fee, and an outside bot
/// earns only the buys still unmade when a window closes. A caller that names an eligible
/// address it does not control pays that address, not itself, so naming one gains the
/// caller nothing — unless that address's own key-holder shares the fee with whoever asks,
/// which takes 690 SPX of their own, and is what the published concentration of window
/// wins (decision 29 of `docs/V2_UPGRADE.md`) watches for. A contract could share it with
/// anyone at all, whoever's SPX it held: Uniswap v2's pair `skim`s a fee paid to it to any
/// caller. That is why the registry finds only accounts eligible.
///
/// The owner is always allowed, so "Trigger now" works inside the window; a buy paid back
/// to its owner pays nobody else. Such a buy is not counted in `windowBuys`, which counts
/// the buys the community made inside their windows. The exception is for whoever is paid,
/// not whoever sends, so anyone may make a buy inside its window by paying the fee back to
/// the owner (and a batch may, for a vault whose owner is its `rewardTo`). The sender gains
/// nothing by it and pays the gas: what it keeps is v1's lever of choosing the moment
/// within a slot (below), without the fee, and the power to take a buy from the community
/// keepers at its own cost.
///
/// A buy falls due at `dueSince`: the later of the earliest moment the clock allows it
/// (`nextBuyAt`) and the start of the slot it is in. `nextBuyAt` alone is in the past once
/// a slot has been missed — gas above the fee, a floor that refused, a vault short of funds
/// until a top-up — and measuring from it would open the first buy after a miss to anyone
/// at once, exactly when a bot is waiting. Measured from the slot's start, every slot's buy
/// gets its own first claim. `dueSince` is at most half an interval into its slot and the
/// window at most a quarter of the interval (the factory's bound), so a window always ends
/// inside the slot it started in, and leaves the rest of the slot open to anyone.
///
/// The registry decides only who may be paid during a window. It is asked with a fixed
/// stipend (`ELIGIBILITY_GAS`), and an answer that is not exactly `true` — a revert, a
/// registry that runs out of gas, or one that answers anything else — counts as "not
/// eligible". So a broken registry can delay a buy only until its window ends, or until the
/// owner triggers it; it can never stop a plan, and it never touches the vault's money.
///
/// ## Turns
///
/// A plan may share the first half of each window out in turns (`turnBuckets`, a term like
/// the others). Every address falls in one of the plan's buckets (`bucketOf`: its hash,
/// modulo the number of buckets), and each buy's slot draws one (`turnOf`: the hash of this
/// vault and the slot). Until `dueSince + communityWindow / 2`, a `rewardTo` other than the
/// owner must be eligible *and* in that bucket; for the rest of the window, any eligible
/// address; after it, anyone. So a holder has first claim on about one buy in `turnBuckets`,
/// and a buy whose bucket nobody is keeping waits half a window for the rest of the
/// community. Turns share first claims out among addresses, not holders: a bot that wants
/// first claim on every buy needs a proven address in every bucket, but the registry reads
/// the balance only at the buy, so one 690 SPX can serve them all, moved into the bucket's
/// address inside each buy's own transaction.
///
/// It is in the contract from the first, unused: every vault the app creates has no turns
/// (0) until decision 29 of `docs/V2_UPGRADE.md` calls for them — one `rewardTo` winning most
/// window buys — when the app can start creating vaults with turns without anything new
/// being deployed. A plan without turns pays one comparison for the feature.
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
/// with zeros. What it does still answer — its limits, `weth`, `registry` and
/// `ELIGIBILITY_GAS` — is true of every clone.
///
/// ## What it deliberately does not do
///
/// - **No admin, no upgrade, no pause switch held by anyone else, no fee.** The terms are
///   part of the clone's code and the implementation's address is part of the proxy, so a
///   vault's behaviour is fixed the moment it exists. The one way to stop a plan is
///   `close`, which returns everything to the owner; there is no pause because a pause is
///   a switch, and a switch is a thing someone has to be trusted with.
/// - **No make-up buys, and no two buys close together.** Time is cut into slots of
///   `interval` seconds from `startAt`, each slot allows at most one buy, and a buy must
///   also come at least half an interval after the last. A slot nobody triggered is
///   skipped, never made up later: a catch-up burst defeats the averaging and is exactly
///   what someone able to delay keepers would want to provoke. The spacing is there so that
///   one push of the price cannot cover the last second of one slot and the first of the
///   next. (v1 called these slots windows; v2 keeps that word for the community window.)
/// - **It never holds the token it buys.** Each swap pays out straight to the owner, and
///   the vault checks the owner received every unit the pair sent — so a fee-on-transfer
///   token is refused outright, even when its fee would fit inside the price floor.
/// - **It pays keepers in WETH**, never with a raw ether call to an unknown address, so
///   the one party that may be anyone cannot run code in the middle of a buy. The registry
///   is asked with `STATICCALL`, which can change nothing, and before anything moves.
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
/// Choose the moment within a due slot, and sandwich the buy: push the v2 price up to
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
/// deep pair, above. So on SPX the realistic harm is skipped slots, not lost funds.
///
/// The cheapest lever refuses one buy, not ten minutes of them. The floor takes the better,
/// for the owner, of the average and the pool's price now, so pushing the price now the
/// owner's way — SPX into the pool — raises the floor inside the same block, with no block
/// boundary to hold, and anyone who orders transactions around a public `execute` can push
/// before it and swap back after. At the pinned block, refusing a buy on a 3% floor takes
/// about 275 ticks, about 0.75 WETH through the pool, and costs about 0.0045 ETH for the
/// round trip: the pool's fee both ways
/// (`test_pushingThePoolsPriceNowRefusesABuyForItsFeesAlone`). It moves none of the owner's
/// money, and the same slot buys once the push is undone; but a keeper that takes the
/// early refusal as "wait for the next slot" loses that slot, and the owner that buy
/// time. (`pnpm keeper` tries a refused vault again ten minutes later, at most twice a
/// slot, so as not to pay for the same refusal without end.)
///
/// It cannot redirect the output, buy twice in a slot, or spend more than one buy's
/// worth plus its reward. Naming `rewardTo` adds nothing to that list: inside a community
/// window a hostile keeper that is not eligible cannot be paid at all, though it can still
/// make the buy by paying the owner, and an eligible one can do exactly what any keeper
/// could do in v1.
///
/// ## What the community window does not stop
///
/// The registry proves that an address held SPX when a block closed. Nothing on chain can
/// prove that SPX held during a transaction is not borrowed, so the check at the moment of
/// a buy can be met with a flash borrow: what eligibility really filters for is "held 690
/// SPX at the end of a block in the last 30 days". A bot that buys 690 SPX and proves it is
/// a community keeper like any holder, and inside a window the fastest eligible keeper
/// wins. None of this reaches the owner's money: at worst a fee is paid to someone the
/// window was meant to keep out, which is what every fee in v1 was open to.
contract SpdexDcaVault is VaultLimits {
    uint256 private constant BPS = 10_000;

    // ─── Shared by every clone ───────────────────────────────────────────────────
    // Immutables are part of this contract's code, which every clone runs, so they are the
    // same for all of them; each clone's own terms are in its code (see `VaultArgs`).

    /// The WETH every vault pays with.
    IWETH9 public immutable weth;
    /// Who decides, inside a community window, whether a `rewardTo` may be paid: the SPX
    /// holder registry the factory was deployed with. Ownerless and immutable, as this is;
    /// another registry means another factory, at another address.
    ISpxHolderRegistry public immutable registry;
    /// This contract's own address. Under a clone's `delegatecall`, `address(this)` is the
    /// clone; only a call made to this contract directly sees the two equal.
    address private immutable self;

    /// The gas the registry's `isEligible` is given. Its honest answer reads one slot of its
    /// own, the holder's code and the holder's SPX balance: two cold slots and two cold
    /// accounts, about 11,200 gas inside the call from cold, 11,700 for an account that has
    /// delegated (the registry's own account is the caller's to pay for, outside it). This is
    /// almost nine times that, because nothing can raise it once a vault exists: a fork that
    /// reprices cold reads (as EIP-2929 tripled them) past a smaller stipend would turn every
    /// window of every vault into one only its owner can be paid in, for good. A buy is
    /// charged only the gas the answer uses, so the headroom costs an honest buy nothing; and
    /// the stipend still bounds what a registry that burns its gas can take from one, which
    /// then counts as not eligible.
    uint256 public constant ELIGIBILITY_GAS = 100_000;

    // ─── State ───────────────────────────────────────────────────────────────────
    // Each clone's own storage. Packed into one slot: every buy writes both counters, and
    // one storage write is a real share of a small buy's gas. `buysDone` never exceeds
    // MAX_BUYS, nor `windowBuys` `buysDone`; a timestamp fits 64 bits for billions of years.
    // `windowBuys` joined the slot in v2, so counting it adds no storage write to a buy.

    uint32 private _buysDone;
    uint64 private _lastBuyAt;
    bool private _closed;
    uint32 private _windowBuys;
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
    /// endpoint dropped, which `slot` cannot show because slots legitimately go unbought.
    /// `keeper` is the caller (an account, or the batcher); `rewardTo` is who was paid
    /// `reward`; `dueSince` is when the buy fell due, so whether it was made inside its
    /// community window (`block.timestamp < dueSince + communityWindow`) and by whom — the
    /// owner, the community, or anyone after the window — can be read from the log alone.
    event Bought(
        uint256 indexed slot,
        uint256 amountIn,
        uint256 amountOut,
        address indexed keeper,
        uint256 reward,
        uint256 floorOut,
        uint256 buyNumber,
        uint256 oracleDepth,
        address indexed rewardTo,
        uint256 dueSince
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
    /// `rewardTo` is the zero address, or this vault, which would pay its own fee to itself.
    error BadRewardTo(address rewardTo);
    /// Inside the community window, `rewardTo` is neither the owner nor eligible. Anyone may
    /// be paid from `windowEndsAt`.
    error NotEligible(address rewardTo, uint256 windowEndsAt);
    /// Inside the first half of the window of a plan with turns, `rewardTo` is eligible but
    /// not in this buy's bucket, `turn`. Any eligible address may be paid from `turnEndsAt`.
    error NotYourTurn(address rewardTo, uint256 turn, uint256 turnEndsAt);

    /// Every function that changes state takes the lock, so a token, pair or owner contract
    /// that calls back mid-transaction finds every door shut rather than only some.
    modifier nonReentrant() {
        if (locked) revert Reentrancy();
        locked = true;
        _;
        locked = false;
    }

    /// @dev Deployed by `SpdexVaultFactory`'s constructor, once. Nothing here is a plan's:
    ///      each clone's terms are written into its code by `createVault`. The factory
    ///      checked that the registry has code.
    constructor(address weth_, address registry_) {
        weth = IWETH9(weth_);
        registry = ISpxHolderRegistry(registry_);
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
    ///
    ///      Nor can the unwrap strand it. WETH sends the ether with `transfer`'s 2,300-gas
    ///      stipend, which a clone's `receive` fits in today (the proxy, a `delegatecall`
    ///      here, two comparisons). A fork that repriced any of that past the stipend, as
    ///      EIP-1884 did to contracts that relied on it, would make `withdraw` revert; were that
    ///      fatal, every vault's `close` would revert with it and no owner could stop a plan
    ///      ever again. So a failed unwrap is not an error: the budget then goes back as WETH.
    ///      `Closed` reports what went back either way.
    function close() external nonReentrant {
        Args memory a = _terms();
        if (msg.sender != a.owner) revert Unauthorized();
        _closed = true;

        uint256 wrapped = weth.balanceOf(address(this));
        uint256 asWeth = wrapped != 0 && !_unwrap(wrapped) ? wrapped : 0;
        // The unwrapped budget, and any ether forced in (by a `selfdestruct`, say).
        uint256 asEther = address(this).balance;
        if (asEther != 0) {
            (bool sent,) = a.owner.call{value: asEther}("");
            if (!sent) {
                weth.deposit{value: asEther}();
                asWeth += asEther;
                asEther = 0;
            }
        }
        if (asWeth != 0) _transfer(address(weth), a.owner, asWeth);
        emit Closed(asEther + asWeth);
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

    /// @notice Make this slot's buy, if it is due, and have `keeperReward` paid in WETH to
    ///         `rewardTo`.
    /// @param rewardTo Who receives this buy's fee. Inside the community window: the owner,
    ///        or an address the registry finds eligible. After it: any address but zero and
    ///        this vault.
    /// @return received What the owner actually received, measured at the owner.
    /// @return reward What `rewardTo` was paid: `keeperReward`, every time.
    /// @dev The caller decides when, and who receives the caller's own fee; nothing about
    ///      the buy. Everything else — the amount, the token, the recipient of what is
    ///      bought, the floor — is fixed by the terms and checked here.
    function execute(address rewardTo) external nonReentrant returns (uint256 received, uint256 reward) {
        Args memory a = _terms();
        if (_closed) revert VaultClosed();
        if (block.timestamp < a.startAt) revert NotStarted(a.startAt);
        uint256 dueSince;
        {
            uint256 nextBuyAt = _nextBuyAt(a);
            if (block.timestamp < nextBuyAt) revert TooSoon(nextBuyAt);
            dueSince = _dueSince(a, nextBuyAt);
        }
        if (_buysDone >= a.maxBuys) revert NoBuysLeft();
        {
            uint256 needed = a.amountPerBuy + a.keeperReward;
            uint256 balance = weth.balanceOf(address(this));
            if (balance < needed) revert InsufficientBalance(balance, needed);
        }
        if (rewardTo == address(0) || rewardTo == address(this)) revert BadRewardTo(rewardTo);

        // The community window, from when this buy fell due. Inside it the fee goes to the
        // owner or to an eligible address — for the first half of a plan with turns, one in
        // this buy's bucket. The registry is asked only when it has to be: a buy after its
        // window, or paid back to its owner, never calls it. A buy the community makes
        // inside its window is counted, in the storage slot the effects below write anyway:
        // no extra storage write.
        {
            uint256 windowEndsAt = dueSince + a.communityWindow;
            if (block.timestamp < windowEndsAt && rewardTo != a.owner) {
                if (!_eligible(rewardTo)) revert NotEligible(rewardTo, windowEndsAt);
                if (a.turnBuckets != 0) {
                    uint256 turnEndsAt = dueSince + a.communityWindow / 2;
                    if (block.timestamp < turnEndsAt) {
                        uint256 turn = _turnOf(a, (dueSince - a.startAt) / a.interval);
                        if (_bucketOf(a, rewardTo) != turn) revert NotYourTurn(rewardTo, turn, turnEndsAt);
                    }
                }
                ++_windowBuys;
            }
        }

        // Effects before anything leaves the vault: this slot is used, whatever follows.
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
        {
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
            // count as a buy — whether or not the shortfall would fit inside the floor, since
            // a floor is an allowance for the market, not for the token.
            uint256 afterward = IERC20Minimal(a.tokenOut).balanceOf(a.owner);
            received = afterward > before ? afterward - before : 0;
            if (received < spotOut) revert DeliveredShort(received, spotOut);
        }

        // Written after the swap because it is only known after it; the lock above is what
        // keeps a callback from observing or changing anything in between.
        _totalOut += received;
        reward = a.keeperReward;
        if (reward != 0) _transfer(address(weth), rewardTo, reward);
        emit Bought(
            (block.timestamp - a.startAt) / a.interval,
            a.amountPerBuy,
            received,
            msg.sender,
            reward,
            floorOut,
            buyNumber,
            depth,
            rewardTo,
            dueSince
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
            maxSlippageBps: a.maxSlippageBps,
            communityWindow: a.communityWindow,
            turnBuckets: a.turnBuckets
        });
    }

    /// @notice The bucket `holder` is in on this plan: whose turn it is when a buy's slot
    ///         draws this number (`turnOf`). 0 for a plan without turns, where every address
    ///         is in the one bucket.
    function bucketOf(address holder) external view returns (uint256) {
        return _bucketOf(_terms(), holder);
    }

    /// @notice The bucket whose eligible holders have first claim on the buy made in slot
    ///         `slot` (counted from `startAt`, as `Bought` counts it), for the first half of
    ///         its community window. 0 for a plan without turns.
    function turnOf(uint256 slot) external view returns (uint256) {
        return _turnOf(_terms(), slot);
    }

    /// @notice Buys made so far.
    function buysDone() external view returns (uint32) {
        _notTheImplementation();
        return _buysDone;
    }

    /// @notice When the last buy was made, chain time; 0 before the first. Its slot, and
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

    /// @notice Buys made inside their community window and paid to someone other than the
    ///         owner: the buys SPX holders made first claim on. With `buysDone`, the share of
    ///         this plan's buys the community made, read from state rather than from logs.
    function windowBuys() external view returns (uint32) {
        _notTheImplementation();
        return _windowBuys;
    }

    /// @notice Everything delivered to the owner so far, in `tokenOut`'s raw units, as
    ///         measured at the owner. With `buysDone` it gives a UI the average price
    ///         without reading logs.
    function totalOut() external view returns (uint256) {
        _notTheImplementation();
        return _totalOut;
    }

    /// @notice Everything a keeper or a page needs to decide cheaply whether `execute` would
    ///         pass, except the price, which is `quote`'s, and whether a `rewardTo` is eligible,
    ///         which is the registry's.
    /// @dev The oracle pool's depth is part of `due` because it is not a moment's question:
    ///      once liquidity leaves a pool, every buy is refused until it comes back, and a
    ///      status that went on saying "due" would have every reader offer a trigger that can
    ///      only revert. The price floor is left to `quote` because it is: it changes with
    ///      every trade on the pair, and "due, but the price is outside the floor" is worth
    ///      saying as such. The pool is read inside a `try`, so a pool that cannot answer a
    ///      ten-minute average right now makes the buy not due rather than this unreadable.
    /// @return due Every check `execute` makes except the price floor passes right now: not
    ///         closed, a buy left, the slot open and the last buy far enough back, the
    ///         budget there, and the oracle pool answering with at least `MIN_ORACLE_DEPTH`.
    /// @return nextBuyAt The earliest moment the next buy may happen, by the clock alone
    ///         (at or before now when `due`; possibly so while not due, for want of budget or
    ///         depth); 0 when none will.
    /// @return buysLeft Buys the plan has left; 0 once closed.
    /// @return wethBalance The WETH held, in wei. Anyone can send a vault WETH, so this can
    ///         exceed what the plan needs, and even `MAX_FUNDING`; `close` returns all of it.
    /// @return funded Whether that covers the next buy and its reward.
    /// @return dueSince When the next buy falls (or fell) due, the moment its community window
    ///         is measured from: `nextBuyAt` until then; from then on, the later of `nextBuyAt`
    ///         and the start of the slot the clock is in, exactly as `execute` works it out. 0
    ///         when no buy is left.
    /// @return windowEndsAt `dueSince + communityWindow`: until this moment the fee can be paid
    ///         only to the owner or an eligible address; from it, to anyone. 0 when no buy is
    ///         left.
    /// @return turnEndsAt Until this moment a `rewardTo` other than the owner must also be in
    ///         the bucket `turn`: `dueSince + communityWindow / 2` for a plan with turns,
    ///         `dueSince` (no turn at all) for one without. 0 when no buy is left.
    /// @return turn The bucket whose eligible holders have first claim on this buy until
    ///         `turnEndsAt` (`turnOf` of the slot `dueSince` is in). 0 without turns.
    function status()
        external
        view
        returns (
            bool due,
            uint256 nextBuyAt,
            uint256 buysLeft,
            uint256 wethBalance,
            bool funded,
            uint256 dueSince,
            uint256 windowEndsAt,
            uint256 turnEndsAt,
            uint256 turn
        )
    {
        Args memory a = _terms();
        wethBalance = weth.balanceOf(address(this));
        funded = wethBalance >= a.amountPerBuy + a.keeperReward;
        buysLeft = _closed ? 0 : a.maxBuys - _buysDone;
        if (buysLeft == 0) return (false, 0, 0, wethBalance, funded, 0, 0, 0, 0);

        nextBuyAt = _nextBuyAt(a);
        dueSince = block.timestamp < nextBuyAt ? nextBuyAt : _dueSince(a, nextBuyAt);
        windowEndsAt = dueSince + a.communityWindow;
        turnEndsAt = a.turnBuckets == 0 ? dueSince : dueSince + a.communityWindow / 2;
        turn = _turnOf(a, (dueSince - a.startAt) / a.interval);
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

    /// @notice Rewards paid so far, in wei, to whichever `rewardTo` each buy named — the owner
    ///         included, when the owner made the buy. Every buy pays the same reward, so this
    ///         is derived rather than stored.
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
    /// the start of the slot after the last buy's or half an interval after the last buy,
    /// whichever is later.
    function _nextBuyAt(Args memory a) private view returns (uint256) {
        uint256 last = _lastBuyAt;
        if (last == 0) return a.startAt;
        uint256 nextWindow = a.startAt + ((last - a.startAt) / a.interval + 1) * a.interval;
        uint256 spaced = last + a.interval / 2;
        return nextWindow > spaced ? nextWindow : spaced;
    }

    /// When the buy due now fell due: the later of `nextBuyAt` and the start of the slot the
    /// clock is in. Only for a moment at or after `nextBuyAt` (which is at or after
    /// `startAt`), so the subtraction cannot underflow.
    function _dueSince(Args memory a, uint256 nextBuyAt) private view returns (uint256) {
        // Dividing first is the point: it rounds the time down to the start of its slot.
        // forge-lint: disable-next-line(divide-before-multiply)
        uint256 slotStart = a.startAt + ((block.timestamp - a.startAt) / a.interval) * a.interval;
        return nextBuyAt > slotStart ? nextBuyAt : slotStart;
    }

    /// Whether the registry says `holder` may be paid inside a community window. Asked with
    /// `STATICCALL` and `ELIGIBILITY_GAS`, copying back one word at most: only a call that
    /// succeeds and answers a whole word equal to 1 — `true`, exactly — counts. A revert, an
    /// out-of-gas, a short answer or any other word is "not eligible" (decision 14 of
    /// `docs/V2_UPGRADE.md`), so the worst a broken registry can do is delay a buy until its
    /// window ends, for at most this stipend's gas.
    function _eligible(address holder) private view returns (bool eligible) {
        address target = address(registry);
        bytes4 selector = ISpxHolderRegistry.isEligible.selector;
        assembly ("memory-safe") {
            // The 36 bytes of calldata, and the one word of answer, fit in scratch space
            // (0x00 to 0x3f): nothing is allocated, and an answer of any length costs this
            // vault one word's copy.
            mstore(0x00, selector)
            mstore(0x04, holder)
            let ok := staticcall(ELIGIBILITY_GAS, target, 0x00, 0x24, 0x00, 0x20)
            // `mload(0)` is the answer's first word only when a whole word came back.
            eligible := and(ok, and(gt(returndatasize(), 0x1f), eq(mload(0x00), 1)))
        }
    }

    /// The bucket `holder` is in: its hash, modulo the plan's buckets; 0 without turns.
    function _bucketOf(Args memory a, address holder) private pure returns (uint256) {
        return a.turnBuckets == 0 ? 0 : uint256(keccak256(abi.encode(holder))) % a.turnBuckets;
    }

    /// The bucket slot `slot` of this vault draws: the hash of the vault and the slot, modulo
    /// the plan's buckets, so each vault's turns fall differently and no bucket is first on
    /// every vault at once. 0 without turns.
    function _turnOf(Args memory a, uint256 slot) private view returns (uint256) {
        return a.turnBuckets == 0 ? 0 : uint256(keccak256(abi.encode(address(this), slot))) % a.turnBuckets;
    }

    /// WETH's `withdraw`, reporting whether it went through instead of reverting with it: see
    /// `close`. The ether arrives through `receive` before this returns.
    function _unwrap(uint256 amount) private returns (bool unwrapped) {
        (unwrapped,) = address(weth).call(abi.encodeCall(IWETH9.withdraw, (amount)));
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
