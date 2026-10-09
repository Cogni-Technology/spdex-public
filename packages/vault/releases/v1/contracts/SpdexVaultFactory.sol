// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.33;

import {SpdexDcaVault, Terms} from "./SpdexDcaVault.sol";
import {
    IUniswapV2FactoryMinimal,
    IUniswapV2PairMinimal,
    IUniswapV3FactoryMinimal,
    IUniswapV3OracleMinimal,
    IWETH9
} from "./interfaces/External.sol";
import {ClonesWithArgs} from "./libraries/ClonesWithArgs.sol";
import {OracleQuote} from "./libraries/OracleQuote.sol";
import {Args, VaultArgs} from "./libraries/VaultArgs.sol";
import {VaultLimits} from "./VaultLimits.sol";

/// @notice A market vaults can buy on: a token, the Uniswap v2 pair every buy trades on, and
///         the Uniswap v3 pool each buy's price floor is read from — both against WETH.
struct Market {
    address tokenOut;
    address pair;
    address oraclePool;
}

/// @title SpdexVaultFactory — creates auto-buy vaults on a fixed list of markets
/// @author spDEX
/// @notice UNAUDITED. Has no owner, no admin, no fee and no upgrade path: it creates vaults
///         for whoever asks, on the markets it was deployed with, and records that it did.
///
/// @dev ## The market list
///
///      A plan names a market by its index in `markets`, and nothing else: whoever creates a
///      vault — or writes a link that creates one — cannot name a pair, a pool or a token.
///      The phase-5a reviews showed why the choice has to be taken away. With any token
///      whose pair and pool exist allowed, the worst findings all followed: an empty or thin
///      genuine v3 pool makes the floor meaningless, a pool can be made "deepest" for the few
///      minutes a choice is made, and a hostile token can run code that traps whoever pays
///      a buy's gas.
///
///      So the list is fixed when the factory is deployed, and the constructor refuses any
///      entry that fails what it can check:
///
///      - the pair is the one Uniswap v2's factory lists for WETH and the token, and the pool
///        is the one Uniswap v3's factory lists for WETH, the token and the pool's fee tier
///        (an imitation answers `token0` and `fee` as well as the real thing; only the
///        factory's own mapping says which is which);
///      - the pool keeps at least `MIN_OBSERVATIONS` of history and has at least
///        `MIN_ORACLE_DEPTH` of depth over the last ten minutes — the vault's own checks;
///      - the pool's ten-minute average agrees with the pair's mid price within
///        `MAX_MARKET_GAP_BPS`, so the floor is read from the same market the buy trades on.
///
///      Those are facts about one moment, the deployment. Depth can leave afterwards, so each
///      vault checks it again at every buy. The pool's history cannot shrink, and the pair and
///      pool cannot stop being Uniswap's. The agreement between the two is the one check never
///      repeated: a vault that refused to buy while they disagreed could be refused by anyone
///      willing to move the pair in the same block, so a buy is judged against the pool alone
///      (`SpdexDcaVault`'s header says what a disagreement does to its floor).
///
///      What these checks vet is the markets, not the token. A token written to trap whoever
///      pays for a buy passes all of them once it has genuine, deep markets, since no check a
///      contract can make tells hostile code from honest. So tokens are vetted by hand, by
///      whoever writes a list; mainnet's is SPX alone.
///
///      Another list means another factory, at another address. There is no way to add or
///      remove a market from this one.
///
///      ## Where it lives
///
///      Deployed through the standard deterministic deployer
///      (0x4e59b44847b379578588920ca78fbf26c0b4956c) with a fixed salt, so its address is a
///      pure function of this bytecode — which includes the vault's, since the constructor
///      deploys the implementation — and of the constructor's arguments: WETH, Uniswap's two
///      factories and the market list. Anyone can rebuild it from source and recompute that
///      address, and the address pins the implementation and the markets together. The app
///      ships the address it expects, checks there is code there, and on a chain where there
///      is not yet, offers the one-time deployment — which anyone may send, since it has no
///      owner to set. Whoever sends it, the list is the same: a deployment attempted while a
///      market fails a check simply reverts, and succeeds when sent again once it passes.
///      (Someone could make it fail on purpose by moving the pair in the same block, paying
///      the pair's fee both ways for each attempt they spoil; the deployer loses one early
///      revert's gas.) Sent through the deterministic deployer, a failure comes back with no
///      reason, since the deployer reverts with none; run the same creation code as a plain
///      `eth_call` without a recipient and the constructor names the entry it refused.
///
///      ## The vaults
///
///      Each vault is an EIP-1167 clone of one implementation, deployed by the constructor,
///      with the plan's terms written into the clone's code (see `SpdexDcaVault`). Its
///      address comes from CREATE2 with the salt `keccak256(owner, nonce)`; since the code
///      carries the terms, the address commits to them too. `predictVault` gives it before
///      the transaction is mined, and no two of one owner's vaults can collide.
///
///      It lists every vault it created, oldest first (`vaultCount`, `vaultsPage`), so that
///      anyone's keeper can find them from this contract alone.
contract SpdexVaultFactory is VaultLimits {
    /// How far a market's pool may disagree with its pair when the list is checked, as the
    /// gap between the pool's ten-minute average and the pair's mid price, in basis points.
    /// The two venues' fees alone put them up to 1.3% apart while arbitrage is idle; further
    /// than this, the pool is stale or steered, or not the market the pair is.
    uint256 public constant MAX_MARKET_GAP_BPS = 200;

    uint256 private constant BPS = 10_000;

    /// The WETH every vault from this factory pays with.
    address public immutable weth;
    /// Uniswap v2's factory, which vouched for every market's pair.
    address public immutable uniswapV2Factory;
    /// Uniswap v3's factory, which vouched for every market's pool.
    address public immutable uniswapV3Factory;
    /// The contract every vault is a clone of, deployed by this factory's constructor.
    address public immutable implementation;

    /// The markets vaults can buy on, fixed at deployment. `markets(i)` for each entry;
    /// `marketCount()` for how many.
    Market[] public markets;

    /// True for every vault this factory created. The app and keepers trust a vault only
    /// when this says it came from here: a clone made by hand runs the same code, but with
    /// whatever terms its maker wrote into it, and nothing vouches for those.
    mapping(address vault => bool) public isVault;

    /// How many vaults each owner has created here; the next one's salt uses this value.
    mapping(address owner => uint256) public nonces;

    /// Every vault this factory created, oldest first: `vaultCount()` and `vaultsPage`. A
    /// keeper finds the vaults it could trigger here, from this factory's own state, rather
    /// than from logs an endpoint may cap, drop or refuse to reach back for. Pushed in the
    /// same call that sets `isVault`, so it says nothing `isVault` does not, and nothing
    /// ever removes an entry. It gives nobody any control.
    address[] private _vaults;

    /// The most addresses one `vaultsPage` call returns, so that a page always fits in what
    /// an endpoint will run as one call.
    uint256 private constant MAX_PAGE = 1_000;

    /// The market's index and the terms as the vault holds them — its market's addresses
    /// included — so that a simulation of the creating transaction shows exactly what the
    /// owner is agreeing to; and `funded`, the ether sent along, which arrives in the vault
    /// as WETH in the same transaction. With the vaults' own `Funded` events, that makes
    /// every deposit readable from this factory's and its vaults' logs alone.
    event VaultCreated(address indexed owner, address indexed vault, uint256 marketIndex, Terms terms, uint256 funded);

    // The list, at deployment. Each names the entry it refused.
    error NoMarkets();
    error NotAUniswapFactory();
    error InvalidToken(uint256 index);
    error DuplicateMarket(uint256 index);
    error PairNotFromUniswap(uint256 index);
    error PoolNotFromUniswap(uint256 index);
    error OracleUnavailable(uint256 index);
    error OracleHistoryTooShort(uint256 index, uint256 observations, uint256 minimum);
    error OracleTooThin(uint256 index, uint256 depth, uint256 minimum);
    error MarketsDisagree(uint256 index, uint256 poolOut, uint256 pairOut);

    // A plan, at creation.
    error UnknownMarket(uint256 index, uint256 count);
    error AmountOutOfRange();
    error IntervalOutOfRange();
    error BuysOutOfRange();
    error SlippageOutOfRange();
    error RewardTooLarge();
    error FundingCapExceeded(uint256 budget, uint256 cap);
    error StartOutOfRange();
    error FundingExceedsNeed(uint256 need);

    constructor(address weth_, address uniswapV2Factory_, address uniswapV3Factory_, Market[] memory markets_) {
        if (markets_.length == 0) revert NoMarkets();
        // Calling a function on an address with no code fails in a way `try` cannot catch;
        // the right answer to a mistyped factory is this error, not an opaque revert.
        if (uniswapV2Factory_.code.length == 0 || uniswapV3Factory_.code.length == 0) revert NotAUniswapFactory();
        for (uint256 i; i < markets_.length; i++) {
            for (uint256 j; j < i; j++) {
                if (markets_[j].tokenOut == markets_[i].tokenOut) revert DuplicateMarket(i);
            }
            _checkMarket(i, markets_[i], weth_, uniswapV2Factory_, uniswapV3Factory_);
            markets.push(markets_[i]);
        }

        weth = weth_;
        uniswapV2Factory = uniswapV2Factory_;
        uniswapV3Factory = uniswapV3Factory_;
        implementation = address(new SpdexDcaVault(weth_));
    }

    /// How many markets `markets` holds.
    function marketCount() external view returns (uint256) {
        return markets.length;
    }

    /// How many vaults this factory has created.
    function vaultCount() external view returns (uint256) {
        return _vaults.length;
    }

    /// The vaults this factory created, oldest first: at most `limit` of them (and never
    /// more than 1,000) from index `offset`, fewer at the end of the list, none from an
    /// `offset` past it.
    function vaultsPage(uint256 offset, uint256 limit) external view returns (address[] memory page) {
        uint256 count = _vaults.length;
        if (offset >= count) return new address[](0);
        // offset < count here, so neither sum can overflow.
        uint256 end = offset + (limit < MAX_PAGE ? limit : MAX_PAGE);
        if (end > count) end = count;
        page = new address[](end - offset);
        for (uint256 i; i < page.length; i++) {
            page[i] = _vaults[offset + i];
        }
    }

    /// @notice Create a vault owned by the caller, buying on market `marketIndex` with this
    ///         plan, funded with whatever ether is sent along (up to the plan's whole budget;
    ///         more is refused).
    /// @dev Checks every term here, once: a clone runs no constructor, and its terms can never
    ///      change after this. The ether is wrapped and passed straight on to the new vault:
    ///      the factory never keeps any.
    function createVault(
        uint256 marketIndex,
        uint256 amountPerBuy,
        uint256 interval,
        uint256 maxBuys,
        uint256 startAt,
        uint256 keeperReward,
        uint256 maxSlippageBps
    ) external payable returns (address vault) {
        Args memory a = _args(
            msg.sender, marketIndex, amountPerBuy, interval, maxBuys, startAt, keeperReward, maxSlippageBps
        );
        _checkPlan(a);
        // Funding at creation: at most the whole budget. More is refused rather than
        // returned, because here — unlike in `fund` — nothing can have changed what the plan
        // needs since the caller worked it out from its own terms.
        uint256 budget = a.maxBuys * (a.amountPerBuy + a.keeperReward);
        if (msg.value > budget) revert FundingExceedsNeed(budget);

        bytes32 salt = keccak256(abi.encode(msg.sender, nonces[msg.sender]++));
        vault = ClonesWithArgs.deploy(implementation, VaultArgs.encode(a), salt);
        isVault[vault] = true;
        _vaults.push(vault);
        emit VaultCreated(msg.sender, vault, marketIndex, _termsOf(a), msg.value);

        // WETH9 is canonical: `deposit` and `transfer` either succeed or revert (its
        // `transfer` never returns false), and call nobody back.
        if (msg.value != 0) {
            IWETH9(weth).deposit{value: msg.value}();
            // forge-lint: disable-next-line(erc20-unchecked-transfer)
            IWETH9(weth).transfer(vault, msg.value);
        }
    }

    /// @notice Where `createVault` would put `owner`'s vault with this nonce and plan.
    /// @dev Does not check the plan: terms `createVault` would refuse have no vault to
    ///      predict. `nonces(owner)` is the nonce of the owner's next vault.
    function predictVault(
        address owner,
        uint256 nonce,
        uint256 marketIndex,
        uint256 amountPerBuy,
        uint256 interval,
        uint256 maxBuys,
        uint256 startAt,
        uint256 keeperReward,
        uint256 maxSlippageBps
    ) external view returns (address) {
        Args memory a = _args(
            owner, marketIndex, amountPerBuy, interval, maxBuys, startAt, keeperReward, maxSlippageBps
        );
        return
            ClonesWithArgs.predict(
                implementation, VaultArgs.encode(a), keccak256(abi.encode(owner, nonce)), address(this)
            );
    }

    // ─── Internals ───────────────────────────────────────────────────────────────

    /// The clone's arguments: the owner, the market's addresses and the plan.
    function _args(
        address owner,
        uint256 marketIndex,
        uint256 amountPerBuy,
        uint256 interval,
        uint256 maxBuys,
        uint256 startAt,
        uint256 keeperReward,
        uint256 maxSlippageBps
    ) private view returns (Args memory a) {
        if (marketIndex >= markets.length) revert UnknownMarket(marketIndex, markets.length);
        Market storage m = markets[marketIndex];
        a.owner = owner;
        a.tokenOut = m.tokenOut;
        a.pair = m.pair;
        a.oraclePool = m.oraclePool;
        a.amountPerBuy = amountPerBuy;
        a.keeperReward = keeperReward;
        a.startAt = startAt;
        a.interval = interval;
        a.maxBuys = maxBuys;
        a.maxSlippageBps = maxSlippageBps;
    }

    /// The bounds every plan must keep: the vault's limits, applied once, here.
    function _checkPlan(Args memory a) private view {
        // Scalars in this order keep every product below from overflowing.
        if (a.amountPerBuy == 0 || a.amountPerBuy > MAX_FUNDING) {
            revert AmountOutOfRange();
        }
        if (a.interval < MIN_INTERVAL || a.interval > MAX_INTERVAL) {
            revert IntervalOutOfRange();
        }
        if (a.maxBuys == 0 || a.maxBuys > MAX_BUYS) revert BuysOutOfRange();
        // Zero would be a floor at the exact mid price, which the pair's own 0.3% fee puts
        // out of reach: a vault that could never buy.
        if (a.maxSlippageBps == 0 || a.maxSlippageBps > MAX_SLIPPAGE_BPS) {
            revert SlippageOutOfRange();
        }
        if (a.keeperReward > a.amountPerBuy || a.keeperReward * BPS > a.amountPerBuy * MAX_REWARD_BPS) {
            revert RewardTooLarge();
        }
        uint256 budget = a.maxBuys * (a.amountPerBuy + a.keeperReward);
        if (budget > MAX_FUNDING) revert FundingCapExceeded(budget, MAX_FUNDING);
        if (a.startAt > block.timestamp + MAX_START_DRIFT || a.startAt + MAX_START_DRIFT < block.timestamp) {
            revert StartOutOfRange();
        }
    }

    function _termsOf(Args memory a) private pure returns (Terms memory) {
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

    /// Everything the constructor can check about one market. See "The market list".
    function _checkMarket(uint256 index, Market memory m, address weth_, address v2, address v3) private view {
        if (m.tokenOut == weth_ || m.tokenOut == address(0)) revert InvalidToken(index);
        if (m.pair == address(0) || IUniswapV2FactoryMinimal(v2).getPair(weth_, m.tokenOut) != m.pair) {
            revert PairNotFromUniswap(index);
        }
        // The pool's fee tier is read from the pool, so an imitation can claim any; but the
        // factory lists only its own pool under each tier, and a tier it does not have lists
        // nothing.
        if (m.oraclePool.code.length == 0) revert PoolNotFromUniswap(index);
        uint24 fee;
        try IUniswapV3OracleMinimal(m.oraclePool).fee() returns (uint24 fee_) {
            fee = fee_;
        } catch {
            revert PoolNotFromUniswap(index);
        }
        if (IUniswapV3FactoryMinimal(v3).getPool(weth_, m.tokenOut, fee) != m.oraclePool) {
            revert PoolNotFromUniswap(index);
        }

        bool wethIsToken0 = weth_ < m.tokenOut;
        int24 meanTick = _checkOracle(index, m.oraclePool, wethIsToken0);

        // Token per WETH, raw units: at the pool's ten-minute average, and at the pair's mid.
        uint256 poolOut = OracleQuote.quoteAtTick(meanTick, 1 ether, weth_, m.tokenOut);
        (uint112 reserve0, uint112 reserve1,) = IUniswapV2PairMinimal(m.pair).getReserves();
        (uint256 reserveWeth, uint256 reserveToken) =
            wethIsToken0 ? (uint256(reserve0), uint256(reserve1)) : (uint256(reserve1), uint256(reserve0));
        uint256 pairOut = reserveWeth == 0 ? 0 : (reserveToken * 1 ether) / reserveWeth;
        uint256 gap = poolOut > pairOut ? poolOut - pairOut : pairOut - poolOut;
        if (pairOut == 0 || gap * BPS > pairOut * MAX_MARKET_GAP_BPS) revert MarketsDisagree(index, poolOut, pairOut);
    }

    /// The pool keeps a history one trade cannot rewrite, answers a ten-minute average, and
    /// has depth behind its price: the vault's own checks. Returns the average tick.
    function _checkOracle(uint256 index, address pool, bool wethIsToken0) private view returns (int24 meanTick) {
        (,,, uint16 observations,,,) = IUniswapV3OracleMinimal(pool).slot0();
        if (observations < MIN_OBSERVATIONS) {
            revert OracleHistoryTooShort(index, observations, MIN_OBSERVATIONS);
        }
        // forge-lint: disable-next-line(unsafe-typecast) — a constant 600 fits 32 bits.
        (bool answered, int24 mean, uint256 liquidity) = OracleQuote.tryConsult(pool, uint32(TWAP_WINDOW));
        if (!answered) revert OracleUnavailable(index);
        meanTick = mean;
        uint256 depth = OracleQuote.wethDepth(meanTick, liquidity, wethIsToken0);
        if (depth < MIN_ORACLE_DEPTH) {
            revert OracleTooThin(index, depth, MIN_ORACLE_DEPTH);
        }
    }
}
