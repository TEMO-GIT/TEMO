// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Website: https://temo.family/
// X:       https://x.com/temoonchain

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {Checkpoints} from "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @title TEMO
/// @notice Fixed supply, minted once. No owner, no mint, no pause, no transfer tax.
///  - keeps a balance history per account (`balanceAt`) for the capsule game
///  - everything else lives in the pool hook
contract TemoToken is ERC20, ERC20Burnable {
    using Checkpoints for Checkpoints.Trace208;

    uint256 public constant SUPPLY = 1_000_000_000 ether;

    mapping(address account => Checkpoints.Trace208) private _history;

    constructor(address recipient) ERC20("Temo", "Temo") {
        _mint(recipient, SUPPLY);
    }

    /// @notice Balance of `account` at `timestamp` (the last checkpoint at or before it).
    function balanceAt(address account, uint48 timestamp) external view returns (uint256) {
        return _history[account].upperLookup(timestamp);
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        uint48 ts = SafeCast.toUint48(block.timestamp);
        if (from != address(0)) _history[from].push(ts, SafeCast.toUint208(balanceOf(from)));
        if (to != address(0)) _history[to].push(ts, SafeCast.toUint208(balanceOf(to)));
    }

    /// @notice Inline metadata read by launch platforms and explorers; lives in bytecode.
    function tokenURI() external pure returns (string memory) {
        return string.concat(
            "data:application/json,{\"name\":\"Temo\",\"symbol\":\"Temo\",",
            "\"description\":\"A blind mole who never saw his own key born in a TEE. No seed phrase. Nobody to peek\",",
            "\"website\":\"https://temo.family/\",\"external_url\":\"https://temo.family/\",",
            "\"x\":\"https://x.com/temoonchain\",\"image\":\"https://temo.family/token.jpg\"}"
        );
    }
}
