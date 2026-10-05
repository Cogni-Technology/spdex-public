// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.33;

import {Test, VmLog} from "./Test.sol";
import {SpdexDcaVault, Terms} from "../../../contracts/SpdexDcaVault.sol";
import {Market, SpdexVaultFactory} from "../../../contracts/SpdexVaultFactory.sol";
import {SpdexVaultBatcher} from "../../../contracts/SpdexVaultBatcher.sol";
import {ClonesWithArgs} from "../../../contracts/libraries/ClonesWithArgs.sol";
import {Args, VaultArgs} from "../../../contracts/libraries/VaultArgs.sol";
import {SpxHolderRegistry} from "../../../contracts/SpxHolderRegistry.sol";

/// What `createVault` takes: a market's index in the factory's list, and the plan.
struct Plan {
    uint256 marketIndex;
    uint256 amountPerBuy;
    uint256 interval;
    uint256 maxBuys;
    uint256 startAt;
    uint256 keeperReward;
    uint256 maxSlippageBps;
    /// Seconds. A test that changes `interval` sets this again (`defaultWindow`), since the
    /// factory holds it to a quarter of the interval.
    uint256 communityWindow;
    /// 0, no turns, as every vault the app creates has; `Turns.t.sol` sets it.
    uint256 turnBuckets;
}

/// One proof `scripts/record-proofs.mjs` recorded from mainnet (`test/fixtures/proofs`): a
/// holder's SPX balance at the end of a block at or before the pinned one, with that block's
/// header, as `prove` takes them.
struct RecordedProof {
    address holder;
    uint256 blockNumber;
    bytes32 blockHash;
    uint256 timestamp;
    uint256 balance;
    bytes header;
    bytes[] accountProof;
    bytes[] storageProof;
}

/// Cheatcodes the fixture needs beyond the shared harness: reading a recorded proof.
interface VmFork {
    function projectRoot() external view returns (string memory);
    function readFile(string calldata path) external view returns (string memory);
    function parseJsonAddress(string calldata json, string calldata key) external pure returns (address);
    function parseJsonUint(string calldata json, string calldata key) external pure returns (uint256);
    function parseJsonBytes32(string calldata json, string calldata key) external pure returns (bytes32);
    function parseJsonBytes(string calldata json, string calldata key) external pure returns (bytes memory);
    function parseJsonBytesArray(string calldata json, string calldata key) external pure returns (bytes[] memory);
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
/// The factory's SPX holder registry is the real `SpxHolderRegistry`, deployed as it will be
/// on mainnet: its own creation code through the deterministic deployer with `REGISTRY_SALT`,
/// so it sits at the address the app and the keeper ship, and the factory's and the
/// batcher's deterministic addresses worked out here are mainnet's. Only the tests of a
/// registry that fails deploy a `MockRegistry` beside it, with a factory of their own.
///
/// An address is made eligible in one of two ways. A real holder is proven from a recorded
/// mainnet proof (`proveRecorded`), exactly as the app and the keeper prove one: that is what
/// the holder tests do. Any other address a test needs eligible (the keeper, a sandwicher, a
/// fee recipient in a gas measurement) gets `makeEligible`: the registry's one record written
/// as a proof would write it, and 690 SPX written into its balance, since no block it held
/// SPX in exists to be proven. Both leave the registry in the same state, so a buy pays for
/// the same reads either way. `keeper` is eligible from the start, so a test about something
/// else can have the keeper make a buy inside its community window, as a community keeper
/// would; `stranger` and `owner` are not.
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

    /// keccak256("spdex.vault.registry.v2"): REGISTRY_SALT in `src/artifacts.ts`. The registry
    /// has no constructor arguments, so its address is a function of its bytecode alone.
    bytes32 internal constant REGISTRY_SALT = keccak256("spdex.vault.registry.v2");
    /// `SpxHolderRegistry.MIN_SPX`: 690 SPX, at 8 decimals.
    uint256 internal constant MIN_SPX = 69_000_000_000;

    /// A real SPX holder (an account with no code): 1,308.2354 SPX from block 25,991,808 to
    /// 25,999,900, and 1,210 at the pinned block. Proven in these tests from its recorded
    /// mainnet proofs, and paid as a community keeper's `rewardTo`. It never signs anything
    /// here: fresh keys send every transaction, as on the shared fork.
    address internal constant HOLDER = 0xb0072E684E532BD1dcC442b5ED22097db205Bb8e;
    /// Its proof 100 blocks before the pinned block, which the registry checks against
    /// `BLOCKHASH`.
    string internal constant HOLDER_PROOF = "holder-b0072e68-25999900.json";
    /// A real holder of about 598.8 SPX at the pinned block: 91.2 short of the minimum.
    address internal constant SHORT_HOLDER = 0xCC01ef33f793Ff0a8dA26d19B2c4428F62753F85;
    /// Its proof at the pinned block, the shortfall the app shows ("You hold 598 of the 690").
    string internal constant SHORT_HOLDER_PROOF = "holder-cc01ef33-26000000.json";

    VmFork internal constant vmf = VmFork(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// `Bought`'s topic: the buy, its floor, its number, the oracle's depth, who was paid and
    /// when the buy fell due.
    bytes32 internal constant BOUGHT_TOPIC =
        keccak256("Bought(uint256,uint256,uint256,address,uint256,uint256,uint256,uint256,address,uint256)");

    /// The SPX holder registry every vault of `factory` asks inside a community window.
    address internal registry;
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

        registry = deployRegistry();
        factory = deployFactory(spxMarkets());
        owner = fresh("owner");
        keeper = fresh("keeper");
        stranger = fresh("stranger");
        vm.deal(owner, 10 ether);
        makeEligible(keeper);
    }

    // ─── The SPX holder registry ─────────────────────────────────────────────────

    /// The registry the fixture's factory is deployed with: `SpxHolderRegistry`, sent to the
    /// deterministic deployer with `REGISTRY_SALT`, as the release deploys it, so at its
    /// mainnet address.
    function deployRegistry() internal virtual returns (address deployed) {
        bytes memory initCode = type(SpxHolderRegistry).creationCode;
        deployed = address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(bytes1(0xff), DETERMINISTIC_DEPLOYER, REGISTRY_SALT, keccak256(initCode))
                    )
                )
            )
        );
        assertEq(deployed.code.length, 0, "the registry is not deployed at the pinned block");
        (bool ok, bytes memory returned) = DETERMINISTIC_DEPLOYER.call(abi.encodePacked(REGISTRY_SALT, initCode));
        assertTrue(ok, "the deterministic deployer deployed the registry");
        assertEq(address(bytes20(returned)), deployed, "where CREATE2 says");
    }

    /// Make `holder` an address the fixture's registry finds eligible: one a vault may pay
    /// inside its community window. The registry keeps one thing, `validUntil`, in a mapping
    /// at slot 0 (`Registry.t.sol` pins the layout); written to the far future here, so a
    /// test may warp as far as it likes. And the holder must hold 690 SPX at the moment of
    /// the buy, so it is given that if it holds less. A real holder is proven instead
    /// (`proveRecorded`).
    function makeEligible(address holder) internal virtual {
        vm.store(registry, keccak256(abi.encode(holder, uint256(0))), bytes32(uint256(type(uint64).max)));
        if (spxOf(holder) < MIN_SPX) giveSpx(holder, MIN_SPX);
    }

    /// A proof recorded from mainnet, by its file name in `test/fixtures/proofs`.
    function recordedProof(string memory name) internal view returns (RecordedProof memory f) {
        string memory json = vmf.readFile(string.concat(vmf.projectRoot(), "/test/fixtures/proofs/", name));
        f.holder = vmf.parseJsonAddress(json, ".holder");
        f.blockNumber = vmf.parseJsonUint(json, ".blockNumber");
        f.blockHash = vmf.parseJsonBytes32(json, ".blockHash");
        f.timestamp = vmf.parseJsonUint(json, ".timestamp");
        f.balance = vmf.parseJsonUint(json, ".balance");
        f.header = vmf.parseJsonBytes(json, ".header");
        f.accountProof = vmf.parseJsonBytesArray(json, ".accountProof");
        f.storageProof = vmf.parseJsonBytesArray(json, ".storageProof");
    }

    /// Prove a real holder with its recorded proof, sent by a fresh key (anyone may prove
    /// anyone): the registry then holds what the app's or the keeper's proof would leave.
    /// Returns the proof's `validUntil`, the block's time plus 30 days.
    function proveRecorded(string memory name) internal returns (uint64 validUntil) {
        RecordedProof memory f = recordedProof(name);
        vm.prank(fresh("prover"));
        validUntil = SpxHolderRegistry(registry).prove(f.holder, f.header, f.accountProof, f.storageProof);
    }

    /// The app's default community window for a plan with this interval: half an hour, or a
    /// quarter of the interval when that is shorter (never below a minute, which a quarter of
    /// the shortest interval, 75 seconds, always clears).
    function defaultWindow(uint256 interval) internal pure returns (uint256) {
        return interval / 4 < 1_800 ? interval / 4 : 1_800;
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

    /// A factory for mainnet WETH on Uniswap's own factories and the fixture's registry, with
    /// this list.
    function deployFactory(Market[] memory list) internal returns (SpdexVaultFactory) {
        return deployFactoryWith(registry, list);
    }

    /// The same, asking another registry.
    function deployFactoryWith(address registry_, Market[] memory list) internal returns (SpdexVaultFactory) {
        return new SpdexVaultFactory(WETH, V2_FACTORY, V3_FACTORY, registry_, list);
    }

    /// A batcher for mainnet WETH: bound to no factory, it serves this suite's vaults as it
    /// serves any. Anyone may deploy one; where it lands is `Batcher.t.sol`'s subject. Salted
    /// under this suite's prefix for the reason `fresh` is: the plain CREATE addresses of
    /// forge's test contract are everyone's, and some hold dust.
    function deployBatcher() internal returns (SpdexVaultBatcher batcher) {
        batcher = new SpdexVaultBatcher{salt: keccak256("spdex.vault.test/batcher")}(WETH);
        assertEq(address(batcher).balance, 0, "a fresh address holds no ether");
    }

    /// The least gas a batch gives each vault, as a keeper sends it today.
    uint256 internal constant BATCH_GAS = 400_000;

    // ─── Plans ───────────────────────────────────────────────────────────────────

    /// A plan the vault should accept: 0.01 ETH of SPX an hour, ten times, 3% floor, and the
    /// app's default community window for an hour, 15 minutes.
    function defaultPlan() internal view returns (Plan memory) {
        return Plan({
            marketIndex: 0,
            amountPerBuy: 0.01 ether,
            interval: 1 hours,
            maxBuys: 10,
            startAt: block.timestamp,
            keeperReward: 0.000069 ether,
            maxSlippageBps: 300,
            communityWindow: defaultWindow(1 hours),
            turnBuckets: 0
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
            maxSlippageBps: p.maxSlippageBps,
            communityWindow: p.communityWindow,
            turnBuckets: p.turnBuckets
        });
    }

    function termsOf(Plan memory p) internal view returns (Terms memory) {
        return termsOn(factory, p);
    }

    /// `createVault`'s calldata, for tests that send it with a raw call or through a contract.
    function createCall(Plan memory p) internal pure returns (bytes memory) {
        return abi.encodeCall(
            SpdexVaultFactory.createVault,
            (
                p.marketIndex,
                p.amountPerBuy,
                p.interval,
                p.maxBuys,
                p.startAt,
                p.keeperReward,
                p.maxSlippageBps,
                p.communityWindow,
                p.turnBuckets
            )
        );
    }

    function createOn(SpdexVaultFactory f, Plan memory p) internal returns (SpdexDcaVault vault) {
        vm.prank(owner);
        vault = SpdexDcaVault(
            payable(f.createVault(
                    p.marketIndex,
                    p.amountPerBuy,
                    p.interval,
                    p.maxBuys,
                    p.startAt,
                    p.keeperReward,
                    p.maxSlippageBps,
                    p.communityWindow,
                    p.turnBuckets
                ))
        );
    }

    /// A vault created on `f` by `who`, with this plan.
    function createAs(SpdexVaultFactory f, address who, Plan memory p) internal returns (address vault) {
        vm.prank(who);
        (bool ok, bytes memory returned) = address(f).call(createCall(p));
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(returned, 0x20), mload(returned))
            }
        }
        vault = abi.decode(returned, (address));
    }

    /// Where `f.createVault` puts `who`'s vault with this nonce and plan, from `predictVault`.
    function predictOn(SpdexVaultFactory f, address who, uint256 nonce, Plan memory p)
        internal
        view
        returns (address)
    {
        return f.predictVault(
            who,
            nonce,
            p.marketIndex,
            p.amountPerBuy,
            p.interval,
            p.maxBuys,
            p.startAt,
            p.keeperReward,
            p.maxSlippageBps,
            p.communityWindow,
            p.turnBuckets
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
                maxSlippageBps: p.maxSlippageBps,
                communityWindow: p.communityWindow,
                turnBuckets: p.turnBuckets
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
