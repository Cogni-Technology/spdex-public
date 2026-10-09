// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.33;

// The few functions the vault, its factory and the batcher call on contracts they do not
// control, and nothing more. Minimal on purpose: every function listed here is one the
// reader has to trust the other contract to implement honestly, so the list is kept to
// what is actually used.

interface IERC20Minimal {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @notice Canonical WETH9. Its `transfer` returns true or reverts, and it has no hooks.
interface IWETH9 is IERC20Minimal {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}

/// @notice A Uniswap v2 pair: where the vault's buys actually trade.
interface IUniswapV2PairMinimal {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}

/// @notice A Uniswap v3 pool, read only as a price oracle: the vault never trades on it.
interface IUniswapV3OracleMinimal {
    function token0() external view returns (address);
    function token1() external view returns (address);
    /// The pool's fee tier: with its two tokens, the key its factory lists it under.
    function fee() external view returns (uint24);
    /// The pool's price now, and how many observations its history keeps
    /// (`observationCardinality`). The vault reads nothing else from it.
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );
    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s);
}

/// @notice Uniswap v2's factory: the one place that can say a pair is genuine. A pair is
///         whatever `getPair` returns for its two tokens; anything else is an imitation.
interface IUniswapV2FactoryMinimal {
    function getPair(address tokenA, address tokenB) external view returns (address pair);
}

/// @notice Uniswap v3's factory, likewise for pools, which it lists by tokens and fee tier.
interface IUniswapV3FactoryMinimal {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
}
