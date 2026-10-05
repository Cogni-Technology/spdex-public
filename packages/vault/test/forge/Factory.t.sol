// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.33;

import {ForkTest, Plan} from "./utils/Fork.sol";
import {VmLog, console} from "./utils/Test.sol";
import {SpdexDcaVault, Terms} from "../../contracts/SpdexDcaVault.sol";
import {Market, SpdexVaultFactory} from "../../contracts/SpdexVaultFactory.sol";

/// The factory: what it records, what it announces, where its vaults land, and where it
/// lives itself. Which markets it will list is `Markets.t.sol`'s subject.
contract FactoryTest is ForkTest {
    /// The salt the factory is deployed with through the deterministic deployer. The same
    /// value is FACTORY_SALT in `packages/vault/src/artifacts.ts`, where it is derived as
    /// keccak256("spdex.vault.factory.v2"); a change to either must change both. v1's was
    /// keccak256("spdex.vault.factory.v1") (V1_FACTORY_SALT): a new release takes a new
    /// salt, though its new bytecode and constructor arguments would each move the address
    /// alone.
    bytes32 internal constant FACTORY_SALT = keccak256("spdex.vault.factory.v2");

    function test_isVaultRecordsOnlyItsOwnVaults() public {
        Plan memory t = defaultPlan();
        SpdexDcaVault made = create(t);
        assertTrue(factory.isVault(address(made)), "a vault it created");

        // The same code with the very same terms, cloned by hand: a working vault, but
        // nothing vouches for it.
        SpdexDcaVault byHand = handMade(SPX, SPX_WETH_PAIR, SPX_WETH_POOL, t);
        assertEq(abi.encode(byHand.terms()), abi.encode(made.terms()), "the same terms");
        assertEq(byHand.owner(), made.owner(), "and owner");
        assertTrue(!factory.isVault(address(byHand)), "not one it created");
        assertTrue(!factory.isVault(factory.implementation()), "nor the implementation");
        assertTrue(!factory.isVault(stranger), "nor an arbitrary address");
    }

    function test_noncesCountPerOwnerAndSetTheAddress() public {
        Plan memory t = defaultPlan();
        assertEq(factory.nonces(owner), 0, "starts at zero");
        address expectedFirst = predict(owner, 0, t);
        assertEq(expectedFirst.code.length, 0, "nothing there before it is created");

        address first = address(create(t));
        address second = address(create(t));
        assertEq(factory.nonces(owner), 2, "one per vault");
        assertEq(factory.nonces(stranger), 0, "per owner");
        assertTrue(first != second, "the same terms twice make two vaults");

        // CREATE2 from (owner, nonce) over code that carries the terms: the app can know the
        // address before it is mined, from the factory's view or by recomputing it.
        assertEq(first, expectedFirst, "first address predicted");
        assertEq(second, predict(owner, 1, t), "second address predicted");
        assertEq(first, predictByHand(owner, 0, t), "and recomputed from the published layout");
        assertEq(second, predictByHand(owner, 1, t), "for both");

        // The address commits to every term: one wei more per buy is another vault.
        Plan memory other = defaultPlan();
        other.amountPerBuy += 1;
        assertTrue(predict(owner, 2, other) != predict(owner, 2, t), "different terms, different address");
        other = defaultPlan();
        other.communityWindow += 1;
        assertTrue(predict(owner, 2, other) != predict(owner, 2, t), "the window too: a second more, another vault");
    }

    function test_vaultCreatedCarriesOwnerVaultMarketTermsAndFunding() public {
        Plan memory t = defaultPlan();
        // Unfunded, then funded with the whole budget: `funded` is the ether sent along.
        for (uint256 k; k < 2; k++) {
            uint256 value = k == 0 ? 0 : budgetOf(t);
            vm.recordLogs();
            vm.prank(owner);
            address vault = factory.createVault{value: value}(
                t.marketIndex,
                t.amountPerBuy,
                t.interval,
                t.maxBuys,
                t.startAt,
                t.keeperReward,
                t.maxSlippageBps,
                t.communityWindow,
                t.turnBuckets
            );
            VmLog[] memory logs = vm.getRecordedLogs();

            bytes32 topic = keccak256(
                "VaultCreated(address,address,uint256,(address,address,address,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256),uint256)"
            );
            uint256 found;
            for (uint256 i; i < logs.length; i++) {
                if (logs[i].emitter != address(factory) || logs[i].topics[0] != topic) continue;
                found++;
                assertEq(address(uint160(uint256(logs[i].topics[1]))), owner, "owner, indexed");
                assertEq(address(uint160(uint256(logs[i].topics[2]))), vault, "vault, indexed");
                (uint256 marketIndex, Terms memory announced, uint256 funded) =
                    abi.decode(logs[i].data, (uint256, Terms, uint256));
                assertEq(marketIndex, 0, "the market's index");
                assertEq(abi.encode(announced), abi.encode(termsOf(t)), "the exact terms, market included");
                assertEq(
                    abi.encode(announced), abi.encode(SpdexDcaVault(payable(vault)).terms()), "as the vault holds them"
                );
                assertEq(funded, value, "the ether sent along");
                assertEq(wethOf(vault), value, "which the vault holds as WETH");
            }
            assertEq(found, 1, "exactly one VaultCreated");
        }
    }

    /// The factory lists every vault it created, oldest first, and nothing else: the list says
    /// what `isVault` says, in order, and pages end where it ends.
    function test_theVaultListIsEveryVaultItCreatedInOrder() public {
        assertEq(factory.vaultCount(), 0, "none yet");
        assertEq(factory.vaultsPage(0, 10).length, 0, "an empty page");

        Plan memory t = defaultPlan();
        address[] memory made = new address[](3);
        made[0] = address(create(t));
        vm.prank(stranger);
        made[1] = factory.createVault(
            t.marketIndex,
            t.amountPerBuy,
            t.interval,
            t.maxBuys,
            t.startAt,
            t.keeperReward,
            t.maxSlippageBps,
            t.communityWindow,
            t.turnBuckets
        );
        made[2] = address(create(t));
        // A clone made by hand is not the factory's, and is not listed.
        handMade(SPX, SPX_WETH_PAIR, SPX_WETH_POOL, t);

        assertEq(factory.vaultCount(), 3, "three created");
        address[] memory all = factory.vaultsPage(0, 10);
        assertEq(all.length, 3, "a page holds what there is");
        for (uint256 i; i < 3; i++) {
            assertEq(all[i], made[i], "oldest first, whoever created it");
            assertTrue(factory.isVault(all[i]), "every listed vault is vouched for");
        }

        address[] memory middle = factory.vaultsPage(1, 1);
        assertEq(middle.length, 1, "at most `limit`");
        assertEq(middle[0], made[1], "from `offset`");
        address[] memory tail = factory.vaultsPage(2, 5);
        assertEq(tail.length, 1, "fewer at the end");
        assertEq(tail[0], made[2], "the last one");
        assertEq(factory.vaultsPage(3, 5).length, 0, "none from the end");
        assertEq(factory.vaultsPage(type(uint256).max, type(uint256).max).length, 0, "none from far past it");
        assertEq(factory.vaultsPage(0, 0).length, 0, "none when none are asked for");
        assertEq(factory.vaultsPage(1, type(uint256).max).length, 2, "a huge limit is the rest");
    }

    /// One page returns at most 1,000 addresses, so a keeper's read always fits in a call.
    function test_aPageHoldsAtMostAThousandVaults() public {
        // Written straight into the list's storage (slot 3: its length, then its elements at
        // keccak256(3)): 1,001 creations would take minutes of fork calls to say the same.
        uint256 count = 1_001;
        vm.store(address(factory), bytes32(uint256(3)), bytes32(count));
        uint256 base = uint256(keccak256(abi.encode(uint256(3))));
        for (uint256 i; i < count; i++) {
            vm.store(address(factory), bytes32(base + i), bytes32(uint256(uint160(0x1000 + i))));
        }
        assertEq(factory.vaultCount(), count, "the length is slot 3");
        address[] memory page = factory.vaultsPage(0, 5_000);
        assertEq(page.length, 1_000, "capped at 1,000");
        assertEq(page[999], address(uint160(0x1000 + 999)), "in order");
        address[] memory rest = factory.vaultsPage(1_000, 5_000);
        assertEq(rest.length, 1, "the rest on the next page");
        assertEq(rest[0], address(uint160(0x1000 + 1_000)), "the last one");
    }

    function test_aRefusedTermFailsTheWholeCreation() public {
        Plan memory t = defaultPlan();
        t.maxSlippageBps = 501;
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(SpdexVaultFactory.SlippageOutOfRange.selector));
        factory.createVault(
            t.marketIndex,
            t.amountPerBuy,
            t.interval,
            t.maxBuys,
            t.startAt,
            t.keeperReward,
            t.maxSlippageBps,
            t.communityWindow,
            t.turnBuckets
        );
        assertEq(factory.nonces(owner), 0, "a refused creation uses no nonce");
    }

    /// A plan names a market by index, and only an index the list has.
    function test_marketIndexIsBounded() public {
        assertEq(factory.marketCount(), 1, "one market");
        (address tokenOut, address pair, address pool) = factory.markets(0);
        assertEq(tokenOut, SPX, "SPX");
        assertEq(pair, SPX_WETH_PAIR, "on its v2 pair");
        assertEq(pool, SPX_WETH_POOL, "floored by its 0.3% pool");

        Plan memory t = defaultPlan();
        for (uint256 i; i < 3; i++) {
            t.marketIndex = i == 0 ? 1 : i == 1 ? 2 : type(uint256).max;
            bytes memory unknown = abi.encodeWithSelector(SpdexVaultFactory.UnknownMarket.selector, t.marketIndex, 1);
            vm.prank(owner);
            vm.expectRevert(unknown);
            factory.createVault(
                t.marketIndex,
                t.amountPerBuy,
                t.interval,
                t.maxBuys,
                t.startAt,
                t.keeperReward,
                t.maxSlippageBps,
                t.communityWindow,
                t.turnBuckets
            );
            vm.expectRevert(unknown);
            predict(owner, 0, t);
        }
        vm.expectRevert();
        factory.markets(1);
    }

    /// The implementation is the factory's first creation, so its address follows from the
    /// factory's; it holds the vault's code and no plan.
    function test_theImplementationIsTheFactorysFirstCreation() public view {
        address expected = createAddress(address(factory), 1);
        assertEq(factory.implementation(), expected, "CREATE from the factory, nonce 1");
        assertGt(expected.code.length, 0, "deployed with the factory");
        assertEq(address(SpdexDcaVault(payable(expected)).weth()), WETH, "paying with the factory's WETH");
        assertEq(address(SpdexDcaVault(payable(expected)).registry()), registry, "asking the factory's registry");
        assertEq(factory.registry(), registry, "the factory's registry");
        assertEq(factory.weth(), WETH, "the factory's WETH");
        assertEq(factory.uniswapV2Factory(), V2_FACTORY, "Uniswap v2's factory");
        assertEq(factory.uniswapV3Factory(), V3_FACTORY, "Uniswap v3's factory");
    }

    /// The deployment the app offers: through the standard deterministic deployer, with a
    /// fixed salt, so the address depends only on this bytecode — the vault's included — and
    /// the constructor's arguments, the registry and the market list among them. The
    /// fixture's registry was deployed the same way, so the address logged here is the one
    /// `src/artifacts.ts` ships as `MAINNET_FACTORY`.
    function test_deployedThroughTheDeterministicDeployerLandsWhereExpected() public {
        bytes memory initCode = abi.encodePacked(
            type(SpdexVaultFactory).creationCode, abi.encode(WETH, V2_FACTORY, V3_FACTORY, registry, spxMarkets())
        );
        address expected = address(
            uint160(
                uint256(
                    keccak256(abi.encodePacked(bytes1(0xff), DETERMINISTIC_DEPLOYER, FACTORY_SALT, keccak256(initCode)))
                )
            )
        );
        assertEq(expected.code.length, 0, "not deployed at the pinned block");

        (bool ok, bytes memory returned) = DETERMINISTIC_DEPLOYER.call(abi.encodePacked(FACTORY_SALT, initCode));
        assertTrue(ok, "the deployer accepted it");
        assertEq(address(bytes20(returned)), expected, "the deployer reports the predicted address");
        SpdexVaultFactory deployed = SpdexVaultFactory(expected);
        assertEq(deployed.weth(), WETH, "a factory for mainnet WETH");
        assertEq(deployed.registry(), registry, "asking this registry");
        (address tokenOut, address pair, address pool) = deployed.markets(0);
        assertTrue(tokenOut == SPX && pair == SPX_WETH_PAIR && pool == SPX_WETH_POOL, "with SPX's market");
        assertEq(deployed.marketCount(), 1, "and only that");
        console.log("SpdexVaultFactory for mainnet WETH, SPX's market and the registry: mainnet's", expected);
        console.log("its implementation", deployed.implementation());

        // Anyone may send it; sending it again cannot replace it. (A CREATE2 collision burns
        // all the gas it is given, hence the cap.)
        (ok,) = DETERMINISTIC_DEPLOYER.call{gas: 10_000_000}(abi.encodePacked(FACTORY_SALT, initCode));
        assertTrue(!ok, "a second deployment to the same address fails");

        // Another list is another factory: the address commits to the markets. So does another
        // registry.
        Market[] memory none = new Market[](0);
        bytes memory otherInit = abi.encodePacked(
            type(SpdexVaultFactory).creationCode, abi.encode(WETH, V2_FACTORY, V3_FACTORY, registry, none)
        );
        assertTrue(keccak256(otherInit) != keccak256(initCode), "a different list is different init code");
        otherInit = abi.encodePacked(
            type(SpdexVaultFactory).creationCode, abi.encode(WETH, V2_FACTORY, V3_FACTORY, WETH, spxMarkets())
        );
        assertTrue(keccak256(otherInit) != keccak256(initCode), "a different registry is different init code");
    }

    /// The registry must be a contract. A vault's `STATICCALL` to an address with no code
    /// succeeds with no answer, which it counts as "not eligible": a mistyped registry would
    /// quietly shut every holder out of every window rather than fail. So it is refused when
    /// the factory is deployed, where the mistake can be named.
    function test_aRegistryWithNoCodeIsRefused() public {
        vm.expectRevert(abi.encodeWithSelector(SpdexVaultFactory.NotARegistry.selector));
        deployFactoryWith(stranger, spxMarkets());
        vm.expectRevert(abi.encodeWithSelector(SpdexVaultFactory.NotARegistry.selector));
        deployFactoryWith(address(0), spxMarkets());
    }

    function predict(address creator, uint256 nonce, Plan memory p) internal view returns (address) {
        return factory.predictVault(
            creator,
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

    /// The address worked out from first principles rather than through the factory or its
    /// libraries: the published args layout, the EIP-1167 init code, CREATE2.
    function predictByHand(address creator, uint256 nonce, Plan memory p) internal view returns (address) {
        bytes memory args = abi.encodePacked(
            creator,
            SPX,
            SPX_WETH_PAIR,
            SPX_WETH_POOL,
            uint64(p.amountPerBuy),
            uint64(p.keeperReward),
            uint64(p.startAt),
            uint32(p.interval),
            uint16(p.maxBuys),
            uint16(p.maxSlippageBps),
            uint32(p.communityWindow),
            uint8(p.turnBuckets)
        );
        assertEq(args.length, 117, "117 bytes of args");
        bytes memory initCode = abi.encodePacked(
            hex"61",
            uint16(0x2d + args.length),
            hex"3d81600a3d39f3",
            hex"363d3d373d3d3d363d73",
            factory.implementation(),
            hex"5af43d82803e903d91602b57fd5bf3",
            args
        );
        bytes32 salt = keccak256(abi.encode(creator, nonce));
        return address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(factory), salt, keccak256(initCode)))))
        );
    }

    /// CREATE's address for a deployer and nonce below 128: RLP([deployer, nonce]).
    function createAddress(address deployer, uint8 nonce) internal pure returns (address) {
        return
            address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xd6), bytes1(0x94), deployer, bytes1(nonce))))));
    }
}
