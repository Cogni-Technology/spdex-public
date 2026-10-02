// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.33;

import {SpdexDcaVault} from "../../../contracts/SpdexDcaVault.sol";
import {SpdexVaultFactory} from "../../../contracts/SpdexVaultFactory.sol";
import {TickMath} from "../../../contracts/libraries/TickMath.sol";

/// A v3-shaped oracle that answers a fixed tick: `observe` reports cumulatives whose mean
/// over any window is exactly `tick`, or the raw pair it is given, and seconds-per-liquidity
/// cumulatives whose harmonic mean is exactly `liquidity`. `slot0` reports the same tick as
/// the price now, and a history of `cardinality` observations.
///
/// Only for the tests where the pool is not the point (a hostile token that has no real
/// v3 market, in a vault made by hand) and for pinning the oracle arithmetic; and as the
/// impostor the factory must refuse to list, since it answers `fee()` like a genuine 0.3%
/// pool without being the one Uniswap's factory lists. The defaults describe a deep pool
/// with a long history, so that a test about something else is not refused for the pool's
/// sake.
contract MockOraclePool {
    address public immutable token0;
    address public immutable token1;
    uint24 public fee = 3000;
    int56 public older;
    int56 public newer;
    int24 public currentTick;
    uint128 public liquidity = 1e24;
    uint16 public cardinality = 1_800;

    constructor(address a, address b) {
        (token0, token1) = a < b ? (a, b) : (b, a);
    }

    function setTick(int24 tick, uint32 window) external {
        older = 0;
        newer = int56(tick) * int56(uint56(window));
        currentTick = tick;
    }

    function setCumulatives(int56 older_, int56 newer_) external {
        older = older_;
        newer = newer_;
    }

    function setCurrentTick(int24 tick) external {
        currentTick = tick;
    }

    function setLiquidity(uint128 liquidity_) external {
        liquidity = liquidity_;
    }

    function setCardinality(uint16 cardinality_) external {
        cardinality = cardinality_;
    }

    function setFee(uint24 fee_) external {
        fee = fee_;
    }

    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (TickMath.getSqrtRatioAtTick(currentTick), currentTick, 0, cardinality, cardinality, 0, true);
    }

    function observe(uint32[] calldata secondsAgos) external view returns (int56[] memory ticks, uint160[] memory liq) {
        ticks = new int56[](secondsAgos.length);
        liq = new uint160[](secondsAgos.length);
        ticks[0] = older;
        ticks[1] = newer;
        // What the pool's accumulator gains over the window at a constant liquidity; an
        // empty range counts as liquidity 1, as in the pool.
        uint256 perLiquidity = (uint256(secondsAgos[0]) << 128) / (liquidity == 0 ? 1 : liquidity);
        liq[1] = uint160(perLiquidity);
    }
}

/// An ERC-20 that, once armed, tries to re-enter the vault from inside its own transfer —
/// which is where a hostile token gets control during a buy: the pair calls it to pay the
/// owner. It records what the vault answered and then completes the transfer, so the test
/// can show the attempt was refused while the honest buy around it went through.
contract ReenteringToken {
    mapping(address => uint256) public balanceOf;
    SpdexDcaVault public target;
    bytes public lastRevert;
    uint256 public attempts;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function arm(SpdexDcaVault vault) external {
        target = vault;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (address(target) != address(0) && to == target.owner()) {
            attempts++;
            try target.execute() {
                lastRevert = "";
            } catch (bytes memory reason) {
                lastRevert = reason;
            }
        }
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// A token that keeps 1% of every transfer. A vault buying it must fail loudly — the
/// owner would receive less than the pair sent — rather than count a short delivery,
/// whether or not the shortfall fits inside the plan's price floor.
contract FeeOnTransferToken {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount - amount / 100;
        return true;
    }
}

/// A vault owner that is a contract, whose `receive` can refuse ether or try to re-enter
/// the vault while `close` is paying it.
contract OwnerContract {
    enum Mode {
        Accept,
        Refuse,
        Reenter
    }

    Mode public mode;
    SpdexDcaVault public vault;
    bytes public executeRevert;
    bytes public fundRevert;
    bytes public closeRevert;

    function setMode(Mode mode_) external {
        mode = mode_;
    }

    /// Sends `createVault`'s calldata to the factory, so that this contract is the owner.
    function create(SpdexVaultFactory factory, bytes calldata createCall) external returns (SpdexDcaVault) {
        (bool ok, bytes memory returned) = address(factory).call(createCall);
        require(ok, "createVault reverted");
        vault = SpdexDcaVault(payable(abi.decode(returned, (address))));
        return vault;
    }

    function fund() external payable {
        vault.fund{value: msg.value}();
    }

    function close() external {
        vault.close();
    }

    receive() external payable {
        if (msg.sender != address(vault)) return;
        if (mode == Mode.Refuse) revert("no ether, thanks");
        if (mode == Mode.Reenter) {
            try vault.execute() {}
            catch (bytes memory reason) {
                executeRevert = reason;
            }
            try vault.fund{value: 1}() {}
            catch (bytes memory reason) {
                fundRevert = reason;
            }
            try vault.close() {}
            catch (bytes memory reason) {
                closeRevert = reason;
            }
        }
    }
}

/// A keeper contract that triggers twice in one transaction, to show the window rule
/// holds within a transaction as well as across them.
contract DoubleKeeper {
    bytes public secondRevert;

    function run(SpdexDcaVault vault) external {
        vault.execute();
        try vault.execute() {}
        catch (bytes memory reason) {
            secondRevert = reason;
        }
    }
}

/// A contract that answers everything a v2 pair is asked — tokens and reserves — with the
/// real pair's answers, without being it. Only Uniswap's factory can tell the two apart,
/// which is why the vault factory asks it.
contract ImpostorPair {
    IPairReads internal immutable real;

    constructor(address real_) {
        real = IPairReads(real_);
    }

    function token0() external view returns (address) {
        return real.token0();
    }

    function token1() external view returns (address) {
        return real.token1();
    }

    function getReserves() external view returns (uint112, uint112, uint32) {
        return real.getReserves();
    }
}

interface IPairReads {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function getReserves() external view returns (uint112, uint112, uint32);
}

// ─── For the batcher ─────────────────────────────────────────────────────────────
// Vault-shaped contracts that answer `execute()` the ways a batcher must survive, vouched
// for by a factory that vouches for whatever a test tells it to. A batcher bound to that
// factory then triggers them as it would a real vault, which is what these tests need:
// the batcher trusts the factory's word and nothing else.

interface IWETHMock {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}

/// A factory that vouches for exactly the addresses a test lists, with mainnet's WETH.
contract MockVaultFactory {
    address public immutable weth;
    mapping(address => bool) public isVault;

    constructor(address weth_) {
        weth = weth_;
    }

    function vouch(address vault) external {
        isVault[vault] = true;
    }
}

/// Records the gas it was given, as `gasleft()` on entry, and answers like a buy with no
/// reward: 32 bytes.
contract GasProbe {
    uint256 public seen;

    function execute() external returns (uint256) {
        seen = gasleft();
        return 1;
    }
}

/// Spends every unit of gas it is given, as a vault built to drain keepers would: `INVALID`
/// takes all of it and leaves no revert data.
contract GasBurner {
    function execute() external pure returns (uint256) {
        assembly {
            invalid()
        }
    }
}

/// Pays its caller a WETH reward and answers like a buy, as a real vault does: the batcher's
/// revenue without an oracle or a market. Holds whatever WETH a test gives it.
contract PayingVault {
    IWETHMock public immutable weth;
    uint256 public immutable reward;

    constructor(address weth_, uint256 reward_) {
        weth = IWETHMock(weth_);
        reward = reward_;
    }

    function execute() external returns (uint256) {
        require(weth.transfer(msg.sender, reward), "reward");
        return 7;
    }
}

/// Refuses at once, with no reason: `EmptyRevert` for the price of a few opcodes.
contract BareRevert {
    fallback() external {
        revert();
    }
}

/// Succeeds with no return data: not a vault's buy, however it looks.
contract SilentVault {
    uint256 public calls;

    fallback() external {
        calls++;
    }
}

/// Reverts with `size` bytes whose first four are 0xdeadbeef. At 256 KB it costs the vault
/// about 156,000 gas of memory, inside the batcher's cap; a caller that copied the answer
/// would pay as much again. The same code at 4 bytes is the comparison.
contract ReturnBomb {
    uint256 public immutable size;

    constructor(uint256 size_) {
        size = size_;
    }

    function execute() external view returns (uint256) {
        uint256 n = size;
        assembly {
            mstore(0, shl(224, 0xdeadbeef))
            revert(0, n)
        }
    }
}

interface IBatcherMock {
    function executeBatch(address[] calldata vaults, address rewardTo, uint256 minRewards)
        external
        returns (uint256 bought, uint256 earned, bytes4[] memory reasons);
}

/// A vouched-for vault whose `execute` calls the batcher back, naming its own `rewardTo`, to
/// take the rewards collected so far; it records what the batcher answered, then pays and
/// answers like a buy so the outer batch goes on.
contract ReenteringVault {
    IWETHMock public immutable weth;
    IBatcherMock public batcher;
    address[] internal targets;
    address public attacker;
    bytes public innerRevert;

    constructor(address weth_) {
        weth = IWETHMock(weth_);
    }

    function aim(IBatcherMock batcher_, address[] calldata targets_, address attacker_) external {
        batcher = batcher_;
        targets = targets_;
        attacker = attacker_;
    }

    function execute() external returns (uint256) {
        try batcher.executeBatch(targets, attacker, 0) {
            innerRevert = "";
        } catch (bytes memory reason) {
            innerRevert = reason;
        }
        require(weth.transfer(msg.sender, 1), "reward");
        return 1;
    }
}
