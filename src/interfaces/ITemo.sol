// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";

interface ITemoToken {
    function balanceAt(address account, uint48 timestamp) external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function burn(uint256 value) external;
    function transfer(address to, uint256 value) external returns (bool);
}

interface ITemoModel {
    /// @notice Score a packed trade record: 0 = will hold, 10000 = will dump.
    function score(uint256 record) external view returns (uint16);
    function weights() external view returns (address);
}

interface IBurrow {
    function onTrade(uint160 sqrtBefore, uint160 sqrtAfter, uint256 ethVolume, bool newWallet) external;
    function buryFor(address owner, bytes32 commit, bytes calldata ciphertext) external;
    function hook() external view returns (address);
}

interface ITemoHook {
    function poolKey() external view returns (PoolKey memory);
    function launchedAt() external view returns (uint40);
    function recordCount() external view returns (uint256);
    function records(uint256 index) external view returns (uint256);
    function positions(uint32 id) external view returns (uint256);
    function burrow() external view returns (address);
    function model() external view returns (address);
    function noteCapsule(address owner, uint40 timestamp) external;
}

interface IPriceFeed {
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
    function decimals() external view returns (uint8);
}
