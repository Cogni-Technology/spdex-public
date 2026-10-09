// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.33;

import {ForkTest, IERC20Test, IV2FactoryTest, IV2PairTest, IV3PoolTest, IWETHTest, Plan} from "./utils/Fork.sol";
import {VmLog, console} from "./utils/Test.sol";
import {PlainToken, IV3FactoryCreate, IV3PoolLiquidity} from "./Hardening.t.sol";
import {GasTrapToken} from "./Review1.t.sol";
import {SpdexDcaVault, Terms} from "../../contracts/SpdexDcaVault.sol";
import {Market, SpdexVaultFactory} from "../../contracts/SpdexVaultFactory.sol";
import {Args, VaultArgs} from "../../contracts/libraries/VaultArgs.sol";
import {OracleQuote} from "../../contracts/libraries/OracleQuote.sol";

// Phase-5b adversarial review, lens: clone and factory security. Each test pins down one
// property the review checked, or one finding it confirmed; the finding tests say which.

interface IV2PairSwapR {
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}

/// A contract laid out like the factory's storage — `markets` in slot 0, `isVault` in slot 1,
/// `nonces` in slot 2, the vault list in slot 3 — that runs the real factory's `createVault`
/// with `delegatecall`. The factory's code then reads *this* contract's market list, which
/// nothing checked.
contract FactoryForger {
    Market[] public markets;
    mapping(address => bool) public isVault;
    mapping(address => uint256) public nonces;
    address[] public vaults;

    function list(Market memory m) external {
        markets.push(m);
    }

    function forge(address factory, bytes calldata call) external returns (address vault) {
        (bool ok, bytes memory returned) = factory.delegatecall(call);
        require(ok, "forged create failed");
        vault = abi.decode(returned, (address));
    }
}

/// An owner of two vaults whose `receive`, run by vault A's refund while A holds its lock,
/// tries A again and then funds B.
contract TwoVaultOwner {
    SpdexDcaVault public a;
    SpdexDcaVault public b;
    bytes public closeARevert;
    bool public fundedB;

    function create(SpdexVaultFactory f, bytes calldata call) external {
        (bool ok, bytes memory returned) = address(f).call(call);
        require(ok, "create failed");
        SpdexDcaVault v = SpdexDcaVault(payable(abi.decode(returned, (address))));
        if (address(a) == address(0)) a = v;
        else b = v;
    }

    function fundA() external payable {
        a.fund{value: msg.value}();
    }

    receive() external payable {
        if (msg.sender != address(a)) return;
        try a.close() {}
        catch (bytes memory reason) {
            closeARevert = reason;
        }
        b.fund{value: msg.value}();
        fundedB = true;
    }
}

contract Review5b0Test is ForkTest {
    int24 internal constant FULL_LOWER = -887_220;
    int24 internal constant FULL_UPPER = 887_220;

    // ─── Bytecode: no CODECOPY, one EXTCODECOPY of ADDRESS, nothing that can destroy ─────

    /// Counts `op` in `code`, walking instructions so that PUSH data is never mistaken for
    /// an opcode; `prev` is the opcode right before the last occurrence.
    function scan(bytes memory code, uint8 op) internal pure returns (uint256 count, uint8 prev) {
        uint8 last;
        for (uint256 i; i < code.length;) {
            uint8 o = uint8(code[i]);
            if (o == op) {
                count++;
                prev = last;
            }
            last = o;
            i += (o >= 0x60 && o <= 0x7f) ? uint256(o) - 0x5e : 1;
        }
    }

    /// The implementation's runtime never uses CODECOPY (which, under a clone's delegatecall,
    /// would read the implementation's own bytes), reads its arguments with exactly one
    /// EXTCODECOPY whose address operand is ADDRESS (the clone), and has no SELFDESTRUCT,
    /// DELEGATECALL, CALLCODE, CREATE or CREATE2. The factory's runtime has no SELFDESTRUCT,
    /// DELEGATECALL or CALLCODE either.
    function test_r5b_bytecodeReadsArgsOnlyWithExtcodecopyOfAddressAndCannotDestroy() public view {
        bytes memory impl = factory.implementation().code;
        (uint256 codecopies,) = scan(impl, 0x39);
        (uint256 extcodecopies, uint8 before) = scan(impl, 0x3c);
        assertEq(codecopies, 0, "no CODECOPY in the implementation");
        assertEq(extcodecopies, 1, "one EXTCODECOPY");
        assertEq(before, 0x30, "whose address operand is ADDRESS");
        uint8[5] memory banned = [0xff, 0xf4, 0xf2, 0xf0, 0xf5];
        for (uint256 i; i < banned.length; i++) {
            (uint256 n,) = scan(impl, banned[i]);
            assertEq(n, 0, "no SELFDESTRUCT/DELEGATECALL/CALLCODE/CREATE/CREATE2 in the implementation");
        }
        bytes memory fac = address(factory).code;
        for (uint256 i; i < 3; i++) {
            (uint256 n,) = scan(fac, banned[i]);
            assertEq(n, 0, "no SELFDESTRUCT/DELEGATECALL/CALLCODE in the factory");
        }
    }

    // ─── Every valid plan: predicted address, exact code, terms read back ────────────────

    /// For any plan the factory accepts, the vault lands where `predictVault` said for the
    /// owner's nonce, its code is exactly the 45-byte proxy for the implementation followed by
    /// the packed terms, its storage starts empty, and it reads the terms back unchanged.
    /// Few runs: every new vault address is an upstream account fetch on the fork, and the
    /// archive endpoint rate-limits (a 429 there is not a failure of this property).
    /// forge-config: default.fuzz.runs = 64
    function testFuzz_r5b_everyValidPlanLandsWherePredictedWithItsTerms(
        uint256 seedOwner,
        uint256 amount,
        uint256 interval,
        uint256 buys,
        int256 startOffset,
        uint256 rewardBps,
        uint256 slippage,
        uint256 window
    ) public {
        Plan memory p;
        p.marketIndex = 0;
        p.maxBuys = 1 + buys % 1_000;
        p.amountPerBuy = 1 + amount % (0.5 ether / p.maxBuys);
        p.keeperReward = (p.amountPerBuy * (rewardBps % 70)) / 10_000;
        if (p.maxBuys * (p.amountPerBuy + p.keeperReward) > 0.5 ether) p.keeperReward = 0;
        p.interval = 300 + interval % (366 days - 300 + 1);
        p.startAt = uint256(int256(block.timestamp) + (startOffset % int256(366 days)));
        p.maxSlippageBps = 1 + slippage % 500;
        // A minute to the lesser of an hour and a quarter of the interval.
        uint256 longest = p.interval / 4 < 1 hours ? p.interval / 4 : 1 hours;
        p.communityWindow = 60 + window % (longest - 60 + 1);

        // Four owners, reused: each new address is an upstream fetch on the fork, and an
        // owner's nonce moving between runs exercises the salt as well.
        address who = fresh(
            string.concat("r5b.owner.", seedOwner % 2 == 0 ? "even" : "odd", seedOwner % 4 < 2 ? ".low" : ".high")
        );
        uint256 nonce = factory.nonces(who);
        p.marketIndex = 0;
        address predicted = predictOn(factory, who, nonce, p);
        address vault = createAs(factory, who, p);
        assertEq(vault, predicted, "where predictVault said");
        assertTrue(factory.isVault(vault), "vouched for");
        bytes memory args = VaultArgs.encode(
            Args(
                who,
                SPX,
                SPX_WETH_PAIR,
                SPX_WETH_POOL,
                p.amountPerBuy,
                p.keeperReward,
                p.startAt,
                p.interval,
                p.maxBuys,
                p.maxSlippageBps,
                p.communityWindow,
                p.turnBuckets
            )
        );
        assertEq(
            vault.code,
            abi.encodePacked(
                hex"363d3d373d3d3d363d73", factory.implementation(), hex"5af43d82803e903d91602b57fd5bf3", args
            ),
            "proxy then packed terms"
        );
        SpdexDcaVault v = SpdexDcaVault(payable(vault));
        assertEq(abi.encode(v.terms()), abi.encode(termsOf(p)), "terms read back");
        assertEq(v.owner(), who, "owner read back");
        assertEq(v.buysDone(), 0, "storage starts empty");
        assertEq(v.lastBuyAt(), 0, "storage starts empty");
        assertEq(v.totalOut(), 0, "storage starts empty");
        assertEq(v.windowBuys(), 0, "storage starts empty");
        assertTrue(!v.closed(), "storage starts empty");
    }

    // ─── The list cannot be widened, not even by running the factory's code elsewhere ────

    /// `createVault` can only index the factory's own list. Running the factory's code with
    /// `delegatecall` from a contract laid out like it does produce a clone of the real
    /// implementation on an unlisted market (USDC here) and a `VaultCreated` log — but from
    /// the forger's address, at a CREATE2 address derived from the forger, and never
    /// `isVault` on the real factory. So the allowlist holds, and every consumer of
    /// `VaultCreated` must check the log's emitter (the keeper filters by address; the Guard
    /// must too — `decodeVaultEvent` reports `emitter` and leaves that check to the caller).
    function test_r5b_runningTheFactoryCodeElsewhereNeverYieldsAVouchedVault() public {
        FactoryForger forger = new FactoryForger();
        forger.list(Market({tokenOut: USDC, pair: USDC_WETH_PAIR, oraclePool: USDC_WETH_POOL}));
        Plan memory p = defaultPlan();

        vm.recordLogs();
        vm.prank(owner);
        address forged = forger.forge(address(factory), createCall(p));
        VmLog[] memory logs = vm.getRecordedLogs();

        assertTrue(!factory.isVault(forged), "the real factory does not vouch for it");
        assertEq(SpdexDcaVault(payable(forged)).terms().tokenOut, USDC, "a clone on an unlisted market");
        bytes32 created = keccak256(
            "VaultCreated(address,address,uint256,(address,address,address,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256),uint256)"
        );
        bool sawForgedLog;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].topics[0] == created) {
                assertEq(logs[i].emitter, address(forger), "the VaultCreated log comes from the forger");
                sawForgedLog = true;
            }
        }
        assertTrue(sawForgedLog, "a VaultCreated log with the factory's exact signature was emitted");
    }

    // ─── Third parties can fund a vault's address before it exists ───────────────────────

    /// CREATE2 needs an address with no code and no nonce, not an empty balance, so ether
    /// and WETH sent to a predicted vault address before its creation are simply there when
    /// it appears. Creation still succeeds, storage still starts empty, and `close` hands it
    /// all to the owner — but the vault then holds more than MAX_FUNDING without the owner
    /// or the factory having put it there, and a buy is "funded" before the owner paid a wei.
    /// Not a loss for anyone but the sender; worth saying where the app says "holds at most
    /// 0.5 ETH" (the contract header now says the cap bounds what the owner can put in, not
    /// what a vault can hold).
    function test_r5b_aPredictedAddressCanBeFundedBeforeItExists() public {
        Plan memory p = defaultPlan();
        address predicted = factory.predictVault(
            owner,
            factory.nonces(owner),
            0,
            p.amountPerBuy,
            p.interval,
            p.maxBuys,
            p.startAt,
            p.keeperReward,
            p.maxSlippageBps,
            p.communityWindow,
            p.turnBuckets
        );
        vm.deal(stranger, 2 ether);
        vm.startPrank(stranger);
        IWETHTest(WETH).deposit{value: 0.6 ether}();
        IERC20Test(WETH).transfer(predicted, 0.6 ether);
        (bool sent,) = predicted.call{value: 0.1 ether}("");
        vm.stopPrank();
        assertTrue(sent, "plain ether is accepted by an address with no code");

        SpdexDcaVault vault = create(p);
        assertEq(address(vault), predicted, "created anyway, where predicted");
        assertEq(vault.buysDone(), 0, "storage starts empty");
        (,,, uint256 held, bool funded,,,,) = vault.status();
        assertGt(held, factory.MAX_FUNDING(), "holds more than the cap");
        assertTrue(funded, "funded before the owner paid anything");

        uint256 before = owner.balance;
        vm.prank(owner);
        vault.close();
        assertEq(owner.balance - before, 0.7 ether, "close returns the stranger's WETH and ether to the owner");
    }

    // ─── The lock is each clone's own ────────────────────────────────────────────────────

    /// The transient lock lives in the clone's own transient storage: while vault A holds
    /// it, A refuses re-entry, and vault B — another clone of the same implementation — is
    /// unaffected. Only the owner of both could use that, on its own vaults.
    function test_r5b_theReentrancyLockIsPerClone() public {
        TwoVaultOwner two = new TwoVaultOwner();
        Plan memory p = defaultPlan();
        two.create(factory, createCall(p));
        two.create(factory, createCall(p));
        vm.deal(address(this), 1 ether);
        two.fundA{value: budgetOf(p) + 0.01 ether}();

        assertEq(two.closeARevert(), abi.encodeWithSelector(SpdexDcaVault.Reentrancy.selector), "A refuses re-entry");
        assertTrue(two.fundedB(), "B, another clone, takes its own lock independently");
        assertEq(wethOf(address(two.b())), 0.01 ether, "and holds the refunded excess");
        assertEq(wethOf(address(two.a())), budgetOf(p), "A kept exactly its need");
    }

    // ─── The listing's market-gap check is never re-applied, by design ───────────────────

    /// Found by this review: `vaultAvailability` said a pool/pair gap above
    /// MAX_MARKET_GAP_BPS meant "buys wait until they agree". They do not, in this direction:
    /// the gap is checked once, when the factory is deployed, and never by the vault (which
    /// is deliberate: a vault that re-checked it could be refused by anyone moving the pair in
    /// the same block). Here SPX is sold into the v2 pair until the pair's mid is ~6% away from
    /// the pool's ten-minute average — a factory with the same list would now refuse to
    /// deploy — and a vault's buy goes through, its floor looser against the pair by the whole
    /// gap. The contract headers say so, and since the fix `vaultAvailability` words the gap
    /// by its direction (`src/index.test.ts`, "a pool quoting fewer tokens than the pair").
    /// Kept as the evidence those words rest on.
    function test_r5b_buysContinueWhileThePoolAndPairDisagreeBeyondTheListingGap() public {
        SpdexDcaVault vault = createFunded(defaultPlan());

        (uint112 reserveWeth, uint112 reserveSpx,) = IV2PairTest(SPX_WETH_PAIR).getReserves();
        uint256 spxIn = uint256(reserveSpx) / 30;
        giveSpx(address(this), spxIn);
        IERC20Test(SPX).transfer(SPX_WETH_PAIR, spxIn);
        uint256 wethOut = (spxIn * 997 * reserveWeth) / (uint256(reserveSpx) * 1000 + spxIn * 997);
        IV2PairSwapR(SPX_WETH_PAIR).swap(wethOut, 0, address(this), "");

        (int24 meanTick,) = OracleQuote.consult(SPX_WETH_POOL, 600);
        uint256 poolOut = OracleQuote.quoteAtTick(meanTick, 1 ether, WETH, SPX);
        (reserveWeth, reserveSpx,) = IV2PairTest(SPX_WETH_PAIR).getReserves();
        uint256 pairOut = (uint256(reserveSpx) * 1 ether) / reserveWeth;
        uint256 gapBps = ((pairOut - poolOut) * 10_000) / pairOut;
        console.log("pool/pair gap, bps", gapBps);
        assertGt(gapBps, factory.MAX_MARKET_GAP_BPS(), "beyond what the listing allowed");

        vm.expectPartialRevert(SpdexVaultFactory.MarketsDisagree.selector);
        deployFactory(spxMarkets());

        vm.prank(keeper);
        vault.execute(keeper);
        assertEq(vault.buysDone(), 1, "the buy did not wait for the markets to agree");
    }

    // ─── Fixed: status() said due while every buy was refused for depth ──────────────────

    /// Found by this review: VAULT-5B asked for the runtime depth check to be reported in
    /// `status()`, and the builder had kept it in `quote()` only — so once the oracle pool's
    /// liquidity left, `status().due` stayed true while every `execute` reverted
    /// `OracleTooThin`, and anything reading `status()` alone would offer "Trigger now"
    /// forever. `due` now includes the depth. (Before the fix this test's first assertion
    /// failed: status said due.)
    function test_r5b_statusIsNotDueWhileEveryBuyIsRefusedForDepth() public {
        (PlainToken token, address pair, address pool) = builtMarket();
        SpdexVaultFactory f = deployFactory(oneMarket(address(token), pair, pool));
        SpdexDcaVault vault = createFundedOn(f, defaultPlan());
        (bool due,,,,,,,,) = vault.status();
        assertTrue(due, "due while the pool is deep");

        IV3PoolLiquidity(pool).burn(FULL_LOWER, FULL_UPPER, 50 ether);
        vm.warp(block.timestamp + 12);
        vm.roll(block.number + 1);

        uint256 nextBuyAt;
        bool funded;
        (due, nextBuyAt,,, funded,,,,) = vault.status();
        assertTrue(!due, "status() is not due once the depth is gone");
        assertTrue(funded && nextBuyAt <= block.timestamp, "though the clock and the budget say it could be");
        (,, uint256 depth) = vault.quote();
        assertLt(depth, factory.MIN_ORACLE_DEPTH(), "quote() says why");
        vm.prank(keeper);
        vm.expectPartialRevert(SpdexDcaVault.OracleTooThin.selector);
        vault.execute(keeper);
    }

    /// A pool that cannot answer a ten-minute average at all ("OLD") makes the buy not due,
    /// and `status()` still answers rather than reverting with the pool. The pool here is
    /// five minutes old, so its history does not reach back ten; the vault is made by hand
    /// because the factory would never list such a pool.
    function test_r5b_statusAnswersWhileThePoolCannotAndSaysNotDue() public {
        PlainToken token = new PlainToken();
        token.mint(address(this), 1e30);
        vm.deal(address(this), 1_000 ether);
        IWETHTest(WETH).deposit{value: 1_000 ether}();
        address pair = IV2FactoryTest(V2_FACTORY).createPair(address(token), WETH);
        IERC20Test(WETH).transfer(pair, 10 ether);
        token.transfer(pair, 10 ether);
        IV2PairTest(pair).mint(address(this));
        address pool = IV3FactoryCreate(V3_FACTORY).createPool(address(token), WETH, 3000);
        IV3PoolTest(pool).initialize(1 << 96);
        IV3PoolLiquidity(pool).increaseObservationCardinalityNext(100);
        IV3PoolLiquidity(pool).mint(address(this), FULL_LOWER, FULL_UPPER, 50 ether, "");
        vm.warp(block.timestamp + 300);
        vm.roll(block.number + 25);

        Plan memory p = defaultPlan();
        SpdexDcaVault vault = handMadeFunded(address(token), pair, pool, p);
        vm.expectRevert(bytes("OLD"));
        vault.quote();
        (bool due, uint256 nextBuyAt,,, bool funded,,,,) = vault.status();
        assertTrue(!due, "not due, and status() did not revert");
        assertTrue(funded && nextBuyAt <= block.timestamp, "though the clock and the budget say it could be");

        // Ten minutes of history later, the same pool answers and the buy is due.
        vm.warp(block.timestamp + 301);
        vm.roll(block.number + 25);
        (due,,,,,,,,) = vault.status();
        assertTrue(due, "due once the pool can answer");
    }

    // ─── The list's checks vet markets, not tokens ───────────────────────────────────────

    /// The hostile-token tests show the factory refusing their markets, but only because
    /// their oracle is a mock pool. Given genuine Uniswap markets — a v2 pair and a 0.3% v3
    /// pool with history, depth and agreeing prices — Review 1's keeper gas trap passes
    /// every listing check, and its vaults are then `isVault`. What keeps it off mainnet is
    /// that the list is SPX alone, chosen by hand, and pinned by the factory's address; the
    /// checks cannot tell a token's code from an honest one. A future list needs the same
    /// hand-vetting of each token's code.
    function test_r5b_aKeeperTrapTokenWithGenuineMarketsPassesEveryListingCheck() public {
        GasTrapToken trap = new GasTrapToken();
        (address pair, address pool) = builtMarketFor(address(trap));
        SpdexVaultFactory f = deployFactory(oneMarket(address(trap), pair, pool));
        (address listed,,) = f.markets(0);
        assertEq(listed, address(trap), "listed");
        SpdexDcaVault vault = createFundedOn(f, defaultPlan());
        assertTrue(f.isVault(address(vault)), "and its vaults are vouched for by that factory");
    }

    /// A fresh token with a v2 pair (10 WETH : 10 tokens) and a 0.3% v3 pool with 50 ether
    /// of full-range liquidity, 100 observations and ten quiet minutes behind it.
    function builtMarket() internal returns (PlainToken token, address pair, address pool) {
        token = new PlainToken();
        (pair, pool) = builtMarketFor(address(token));
    }

    function builtMarketFor(address tokenAddress) internal returns (address pair, address pool) {
        PlainToken token = PlainToken(tokenAddress);
        token.mint(address(this), 1e30);
        vm.deal(address(this), 1_000 ether);
        IWETHTest(WETH).deposit{value: 1_000 ether}();
        pair = IV2FactoryTest(V2_FACTORY).createPair(address(token), WETH);
        IERC20Test(WETH).transfer(pair, 10 ether);
        token.transfer(pair, 10 ether);
        IV2PairTest(pair).mint(address(this));
        pool = IV3FactoryCreate(V3_FACTORY).createPool(address(token), WETH, 3000);
        IV3PoolTest(pool).initialize(1 << 96);
        IV3PoolLiquidity(pool).increaseObservationCardinalityNext(100);
        vm.warp(block.timestamp + 12);
        vm.roll(block.number + 1);
        IV3PoolLiquidity(pool).mint(address(this), FULL_LOWER, FULL_UPPER, 50 ether, "");
        vm.warp(block.timestamp + 601);
        vm.roll(block.number + 50);
    }

    function uniswapV3MintCallback(uint256 owed0, uint256 owed1, bytes calldata) external {
        if (owed0 > 0) IERC20Test(IV3PoolLiquidity(msg.sender).token0()).transfer(msg.sender, owed0);
        if (owed1 > 0) IERC20Test(IV3PoolLiquidity(msg.sender).token1()).transfer(msg.sender, owed1);
    }
}
