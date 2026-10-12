// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Infinite 1-2-5 grid: ... 1k | 2k | 5k | 10k | 20k | 50k ... Bucket index = 3 * log10 + {0,1,2}.
///         Index 0 = value 0. Values in [1, 2) of a decade -> +0, [2, 5) -> +1, [5, 10) -> +2.
library Grid125 {
    function bucket(uint256 value) internal pure returns (uint32) {
        if (value == 0) return 0;
        uint256 e = 0;
        uint256 pow = 1;
        while (value >= pow * 10) {
            pow *= 10;
            unchecked {
                ++e;
            }
        }
        uint256 m = value / pow; // 1..9
        uint256 step = m < 2 ? 0 : (m < 5 ? 1 : 2);
        return uint32(1 + 3 * e + step);
    }

    /// @notice Lower bound of a bucket, for display and tests. Bucket 0 -> 0.
    function lowerBound(uint32 index) internal pure returns (uint256) {
        if (index == 0) return 0;
        uint256 i = index - 1;
        uint256 e = i / 3;
        uint256 step = i % 3;
        uint256 pow = 1;
        for (uint256 k = 0; k < e; ++k) pow *= 10;
        return pow * (step == 0 ? 1 : (step == 1 ? 2 : 5));
    }
}
