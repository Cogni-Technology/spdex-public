// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.33;

import {Test, VmLog} from "./Test.sol";
import {SpdexDcaVault, Terms} from "../../../contracts/SpdexDcaVault.sol";
import {Market, SpdexVaultFactory} from "../../../contracts/SpdexVaultFactory.sol";
import {SpdexVaultBatcher} from "../../../contracts/SpdexVaultBatcher.sol";
import {ClonesWithArgs} from "../../../contracts/libraries/ClonesWithArgs.sol";
import {Args, VaultArgs} from "../../../contracts/libraries/VaultArgs.sol";

/// What `createVault` takes: a market's index in the factory's list, and the plan.
struct Plan {
    uint256 marketIndex;
    uint256 amountPerBuy;
    uint256 interval;
    uint256 maxBuys;
    uint256 startAt;
    uint256 keeperReward;
    uint256 maxSlippageBps;
}

interface IERC20Test {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
}

interface IWETHTest is IERC20Test {
    function deposit() external payable;
}

interface IV2RouterTest {
    function swapExactETHForTokens(uint256 amountOutMin, address[] calldata path, address to, uint256 deadline)
        external
        payable
        returns (uint256[] memory);
}

interface IV2FactoryTest {
    function createPair(address a, address b) external returns (address);
}

interface IV2PairTest {
    function getReserves() external view returns (uint112, uint112, uint32);
    function mint(address to) external returns (uint256);
}

interface IV3FactoryTest {
    function createPool(address a, address b, uint24 fee) external returns (address);
}

interface IV3PoolTest {
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool);
    function initialize(uint160 sqrtPriceX96) external;
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata)
        external
        returns (int256, int256);
}

/// Mainnet at the repository's pinned block, with the pools the vault is meant for, and a
/// factory whose market list is exactly the one mainnet's will be: WETH to SPX, on the v2
/// pair and the 0.3% v3 pool.
///
/// Every test forks from SPDEX_FORK_RPC_URL (an archive endpoint) at block 26000000 —
/// the same block the rest of the repo pins — and never touches the shared local fork.
/// `vm.warp` is used freely: it moves only this test's EVM.
abstract contract ForkTest is Test {
    uint256 internal constant FORK_BLOCK = 26_000_000;

    address internal constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    /// SPX6900: 8 decimals.
    address internal constant SPX = 0xE0f63A424a4439cBE457D80E4f4b51aD25b2c56C;
    address internal constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    /// Uniswap v2 SPX/WETH: where SPX's liquidity is, and where the vault trades.
    address internal constant SPX_WETH_PAIR = 0x52c77b0CB827aFbAD022E6d6CAF2C44452eDbc39;
    /// Uniswap v3 SPX/WETH 0.3%: the deepest SPX pool with history, the vault's oracle.
    address internal constant SPX_WETH_POOL = 0x7C706586679Af2BA6D1A9fC2DA9C6aF59883fdD3;
    address internal constant USDC_WETH_PAIR = 0xB4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc;
    address internal constant USDC_WETH_POOL = 0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640;
    address internal constant V2_ROUTER = 0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D;
    address internal constant V2_FACTORY = 0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f;
    address internal constant V3_FACTORY = 0x1F98431c8aD98523631AE4a59f267346ea31F984;
    address internal constant DETERMINISTIC_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    /// `Bought`'s topic: the buy, its floor, its number and the oracle's depth.
    bytes32 internal constant BOUGHT_TOPIC =
        keccak256("Bought(uint256,uint256,uint256,address,uint256,uint256,uint256,uint256)");

    SpdexVaultFactory internal factory;
    address internal owner;
    address internal keeper;
    address internal stranger;

    function setUp() public virtual {
        string memory url = vm.envOr("SPDEX_FORK_RPC_URL", string(""));
        if (bytes(url).length == 0) {
            fail("SPDEX_FORK_RPC_URL is not set: these tests fork mainnet at block 26000000 from an archive endpoint");
        }
        vm.createSelectFork(url, FORK_BLOCK);

        factory = deployFactory(spxMarkets());
        owner = fresh("owner");
        keeper = fresh("keeper");
        stranger = fresh("stranger");
        vm.deal(owner, 10 ether);
    }

    /// An address nobody has used: derived under this suite's own prefix, because the
    /// well-known `keccak256(name)` keys have been funded, drained and delegated on
    /// mainnet by people testing exactly this way.
    function fresh(string memory name) internal returns (address account) {
        account = makeAddr(string.concat("spdex.vault.test/", name));
        assertEq(account.code.length, 0, "a fresh address has no code");
    }

    // ─── Markets and factories ───────────────────────────────────────────────────

    /// The mainnet list: SPX, bought on its v2 pair, floored by its 0.3% v3 pool.
    function spxMarkets() internal pure returns (Market[] memory list) {
        list = new Market[](1);
        list[0] = Market({tokenOut: SPX, pair: SPX_WETH_PAIR, oraclePool: SPX_WETH_POOL});
    }

    function oneMarket(address tokenOut, address pair, address pool) internal pure returns (Market[] memory list) {
        list = new Market[](1);
        list[0] = Market({tokenOut: tokenOut, pair: pair, oraclePool: pool});
    }

    /// A factory for mainnet WETH on Uniswap's own factories, with this list.
    function deployFactory(Market[] memory list) internal returns (SpdexVaultFactory) {
        return new SpdexVaultFactory(WETH, V2_FACTORY, V3_FACTORY, list);
    }

    /// The batcher bound to this suite's factory. Anyone may deploy one; where it lands is
    /// `Batcher.t.sol`'s subject. Salted under this suite's prefix for the reason `fresh` is:
    /// the plain CREATE addresses of forge's test contract are everyone's, and some hold dust.
    function deployBatcher() internal returns (SpdexVaultBatcher batcher) {
        batcher = new SpdexVaultBatcher{salt: keccak256("spdex.vault.test/batcher")}(address(factory));
        assertEq(address(batcher).balance, 0, "a fresh address holds no ether");
    }

    // ─── Plans ───────────────────────────────────────────────────────────────────

    /// A plan the vault should accept: 0.01 ETH of SPX an hour, ten times, 3% floor.
    function defaultPlan() internal view returns (Plan memory) {
        return Plan({
            marketIndex: 0,
            amountPerBuy: 0.01 ether,
            interval: 1 hours,
            maxBuys: 10,
            startAt: block.timestamp,
            keeperReward: 0.000069 ether,
            maxSlippageBps: 300
        });
    }

    function budgetOf(Plan memory p) internal pure returns (uint256) {
        return p.maxBuys * (p.amountPerBuy + p.keeperReward);
    }

    /// The terms a vault created on `f` with this plan holds: its market's addresses, and the plan.
    function termsOn(SpdexVaultFactory f, Plan memory p) internal view returns (Terms memory) {
        (address tokenOut, address pair, address pool) = f.markets(p.marketIndex);
        return Terms({
            tokenOut: tokenOut,
            pair: pair,
            oraclePool: pool,
            amountPerBuy: p.amountPerBuy,
            interval: p.interval,
            maxBuys: p.maxBuys,
            startAt: p.startAt,
            keeperReward: p.keeperReward,
            maxSlippageBps: p.maxSlippageBps
        });
    }

    function termsOf(Plan memory p) internal view returns (Terms memory) {
        return termsOn(factory, p);
    }

    /// `createVault`'s calldata, for tests that send it with a raw call or through a contract.
    function createCall(Plan memory p) internal pure returns (bytes memory) {
        return abi.encodeCall(
            SpdexVaultFactory.createVault,
            (p.marketIndex, p.amountPerBuy, p.interval, p.maxBuys, p.startAt, p.keeperReward, p.maxSlippageBps)
        );
    }

    function createOn(SpdexVaultFactory f, Plan memory p) internal returns (SpdexDcaVault vault) {
        vm.prank(owner);
        vault = SpdexDcaVault(
            payable(f.createVault(
                    p.marketIndex, p.amountPerBuy, p.interval, p.maxBuys, p.startAt, p.keeperReward, p.maxSlippageBps
                ))
        );
    }

    function create(Plan memory p) internal returns (SpdexDcaVault) {
        return createOn(factory, p);
    }

    function createFundedOn(SpdexVaultFactory f, Plan memory p) internal returns (SpdexDcaVault vault) {
        vault = createOn(f, p);
        vm.prank(owner);
        vault.fund{value: budgetOf(p)}();
    }

    function createFunded(Plan memory p) internal returns (SpdexDcaVault) {
        return createFundedOn(factory, p);
    }

    /// A vault made by hand: a clone of the factory's implementation carrying whatever terms
    /// its maker writes, created outside the factory — so on any market at all, checked by
    /// nobody, and not one the factory vouches for. The tests that need a market no factory
    /// would list (a hostile token, a mock oracle) use this: the vault's own defences are
    /// what they test, and those are the same code whoever made the clone.
    function handMade(address tokenOut, address pair, address pool, Plan memory p)
        internal
        returns (SpdexDcaVault vault)
    {
        bytes memory args = VaultArgs.encode(
            Args({
                owner: owner,
                tokenOut: tokenOut,
                pair: pair,
                oraclePool: pool,
                amountPerBuy: p.amountPerBuy,
                keeperReward: p.keeperReward,
                startAt: p.startAt,
                interval: p.interval,
                maxBuys: p.maxBuys,
                maxSlippageBps: p.maxSlippageBps
            })
        );
        vault = SpdexDcaVault(payable(ClonesWithArgs.deploy(factory.implementation(), args, keccak256(args))));
    }

    function handMadeFunded(address tokenOut, address pair, address pool, Plan memory p)
        internal
        returns (SpdexDcaVault vault)
    {
        vault = handMade(tokenOut, pair, pool, p);
        vm.prank(owner);
        vault.fund{value: budgetOf(p)}();
    }

    function spxOf(address account) internal view returns (uint256) {
        return IERC20Test(SPX).balanceOf(account);
    }

    function wethOf(address account) internal view returns (uint256) {
        return IERC20Test(WETH).balanceOf(account);
    }

    // ─── Moving prices ───────────────────────────────────────────────────────────

    /// Buy SPX with `ethIn` on the v2 pair, from a throwaway address: the spot price the
    /// vault trades at rises, and the 10-minute average does not.
    function pushV2(uint256 ethIn) internal {
        address whale = fresh("whale");
        vm.deal(whale, ethIn);
        address[] memory path = new address[](2);
        path[0] = WETH;
        path[1] = SPX;
        vm.prank(whale);
        IV2RouterTest(V2_ROUTER).swapExactETHForTokens{value: ethIn}(0, path, whale, block.timestamp);
    }

    /// Give `to` `amount` raw SPX by writing its balance. SPX keeps balances in mapping
    /// slot 1 (checked against the pair's balance on chain).
    function giveSpx(address to, uint256 amount) internal {
        vm.store(SPX, keccak256(abi.encode(to, uint256(1))), bytes32(amount));
    }

    /// Move the v3 pool's price to the v2 pair's, whichever way that is. WETH is token0 in
    /// both, so the price is SPX per WETH: paying in WETH lowers it, paying in SPX raises it.
    function moveV3ToV2Price() internal {
        (uint112 reserveWeth, uint112 reserveSpx,) = IV2PairTest(SPX_WETH_PAIR).getReserves();
        uint160 target = uint160(sqrt((uint256(reserveSpx) << 192) / reserveWeth));
        (uint160 current,,,,,,) = IV3PoolTest(SPX_WETH_POOL).slot0();
        if (target < current) {
            vm.deal(address(this), 1_000 ether);
            IWETHTest(WETH).deposit{value: 1_000 ether}();
            IV3PoolTest(SPX_WETH_POOL).swap(address(this), true, int256(1_000 ether), target, "");
        } else if (target > current) {
            giveSpx(address(this), 200_000_000 * 1e8);
            IV3PoolTest(SPX_WETH_POOL).swap(address(this), false, int256(200_000_000 * 1e8), target, "");
        }
        (uint160 sqrtPriceX96,,,,,,) = IV3PoolTest(SPX_WETH_POOL).slot0();
        assertEq(sqrtPriceX96, target, "the v3 pool reached the v2 pair's price");
    }

    /// Pays for `moveV3ToV2Price`'s swap. Only the pool it is swapping on may call it.
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        assertEq(msg.sender, SPX_WETH_POOL, "callback from the pool being swapped on");
        if (amount0Delta > 0) IERC20Test(WETH).transfer(msg.sender, uint256(amount0Delta));
        if (amount1Delta > 0) IERC20Test(SPX).transfer(msg.sender, uint256(amount1Delta));
    }

    function sqrt(uint256 x) internal pure returns (uint256 y) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2;
        y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
    }

    function bought(VmLog[] memory logs, address vault) internal pure returns (uint256 count) {
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == vault && logs[i].topics[0] == BOUGHT_TOPIC) count++;
        }
    }

    receive() external payable {}
}
