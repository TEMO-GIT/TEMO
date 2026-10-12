// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Website: <fill in before deploy>
// X:       <fill in before deploy>

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

    constructor(address recipient) ERC20("TEMO", "TEMO") {
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
            "data:application/json,{\"name\":\"TEMO\",\"symbol\":\"TEMO\",",
            "\"description\":\"A blind mole lives in a sealed enclave and sets the pool fee trade by trade: bots pay more, holders pay less. Every season, capsules predict the week and the fee pool pays the ones who guessed.\",",
            "\"website\":\"https://<fill in before deploy>\",\"external_url\":\"https://<fill in before deploy>\",",
            "\"x\":\"https://x.com/<fill in before deploy>\",\"image\":\"https://<fill in before deploy>/token.png\"}"
        );
    }
}
