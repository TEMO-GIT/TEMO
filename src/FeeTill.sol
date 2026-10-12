// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Website: <fill in before deploy>
// X:       <fill in before deploy>

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";

/// @title FeeTill
/// @notice Holds ERC-6909 ETH claims (id 0) minted by the hook and pays them out, as ETH, to one immutable
///         recipient. Anyone may trigger the payout. No owner, no other destination.
contract FeeTill is IUnlockCallback {
    IPoolManager public immutable poolManager;
    address public immutable recipient;

    error NothingToCollect();
    error NotPoolManager();
    error ZeroAddress();

    event Collected(address indexed recipient, uint256 amount);

    constructor(IPoolManager poolManager_, address recipient_) {
        if (address(poolManager_) == address(0) || recipient_ == address(0)) revert ZeroAddress();
        poolManager = poolManager_;
        recipient = recipient_;
    }

    /// @notice Burn every ETH claim held here and send the ETH to `recipient`.
    function collect() external {
        if (poolManager.balanceOf(address(this), 0) == 0) revert NothingToCollect();
        poolManager.unlock("");
    }

    function unlockCallback(bytes calldata) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        uint256 amount = poolManager.balanceOf(address(this), 0);
        poolManager.burn(address(this), 0, amount);
        poolManager.take(Currency.wrap(address(0)), recipient, amount);
        emit Collected(recipient, amount);
        return "";
    }
}
