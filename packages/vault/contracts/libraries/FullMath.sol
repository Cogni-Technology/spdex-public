// SPDX-License-Identifier: MIT
pragma solidity 0.8.33;

/// @title FullMath: 512-bit multiply, then divide, without losing precision
/// @notice Vendored from Uniswap v3-core (`contracts/libraries/FullMath.sol`, MIT),
///         which credits Remco Bloemen (https://xn--2-umb.com/21/muldiv, MIT).
/// @dev The algorithm is Uniswap's, unchanged. What changed is only what Solidity 0.8
///      needs: the body sits in `unchecked`, because the original was written for 0.7
///      and relies on arithmetic wrapping modulo 2^256 (the modular inverse below is
///      nothing but wrapping multiplications), and `-denominator` on an unsigned
///      integer is spelled `0 - denominator`. The two `require`s became custom errors
///      so this file follows the rest of the contracts; they fire in exactly the same
///      cases. `test/forge/Math.t.sol` checks known values against the original's.
library FullMath {
    /// @notice The denominator was zero, or the result does not fit in 256 bits.
    error MulDivOverflow();

    /// @notice floor(a × b ÷ denominator), with a full 512-bit intermediate product.
    function mulDiv(uint256 a, uint256 b, uint256 denominator) internal pure returns (uint256 result) {
        unchecked {
            // 512-bit multiply [prod1 prod0] = a * b, via the Chinese Remainder Theorem:
            // mulmod gives the product modulo 2^256 - 1, mul gives it modulo 2^256, and
            // the difference recovers the high word.
            uint256 prod0; // least significant 256 bits of the product
            uint256 prod1; // most significant 256 bits of the product
            assembly {
                let mm := mulmod(a, b, not(0))
                prod0 := mul(a, b)
                prod1 := sub(sub(mm, prod0), lt(mm, prod0))
            }

            // The product fits in 256 bits: an ordinary division does.
            if (prod1 == 0) {
                if (denominator == 0) revert MulDivOverflow();
                assembly {
                    result := div(prod0, denominator)
                }
                return result;
            }

            // The result must fit in 256 bits, which also rules out a zero denominator.
            if (denominator <= prod1) revert MulDivOverflow();

            // Make the division exact by subtracting the remainder from [prod1 prod0].
            uint256 remainder;
            assembly {
                remainder := mulmod(a, b, denominator)
            }
            assembly {
                prod1 := sub(prod1, gt(remainder, prod0))
                prod0 := sub(prod0, remainder)
            }

            // Factor the largest power of two out of the denominator. It is at least 1.
            uint256 twos = (0 - denominator) & denominator;
            assembly {
                denominator := div(denominator, twos)
            }
            assembly {
                prod0 := div(prod0, twos)
            }
            // Shift bits from prod1 into prod0: twos becomes 2^256 / twos.
            assembly {
                twos := add(div(sub(0, twos), twos), 1)
            }
            prod0 |= prod1 * twos;

            // The denominator is now odd, so it has an inverse modulo 2^256. Newton-Raphson
            // doubles the correct bits each step, from a seed correct to four bits.
            uint256 inv = (3 * denominator) ^ 2;
            inv *= 2 - denominator * inv; // inverse mod 2^8
            inv *= 2 - denominator * inv; // inverse mod 2^16
            inv *= 2 - denominator * inv; // inverse mod 2^32
            inv *= 2 - denominator * inv; // inverse mod 2^64
            inv *= 2 - denominator * inv; // inverse mod 2^128
            inv *= 2 - denominator * inv; // inverse mod 2^256

            // The division is exact, so multiplying by the inverse gives the answer
            // modulo 2^256, and since the result is below 2^256 that is the answer.
            result = prod0 * inv;
            return result;
        }
    }
}
