// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Grid125} from "../src/libraries/Grid125.sol";
import {TradeRecord} from "../src/libraries/TradeRecord.sol";
import {FeeCalc} from "../src/libraries/FeeCalc.sol";

contract LibrariesTest is Test {
    function test_grid() public pure {
        assertEq(Grid125.bucket(0), 0);
        assertEq(Grid125.bucket(1), 1);
        assertEq(Grid125.bucket(2), 2);
        assertEq(Grid125.bucket(4), 2);
        assertEq(Grid125.bucket(5), 3);
        assertEq(Grid125.bucket(9), 3);
        assertEq(Grid125.bucket(10), 4);
        assertEq(Grid125.bucket(19_999), 13); // 10k..20k
        assertEq(Grid125.bucket(20_000), 14);
        assertEq(Grid125.bucket(49_999), 14);
        assertEq(Grid125.bucket(50_000), 15);
        assertEq(Grid125.bucket(99_999), 15);
        assertEq(Grid125.bucket(100_000), 16);
        assertEq(Grid125.bucket(1_000_000), 19);
        assertEq(Grid125.lowerBound(14), 20_000);
        assertEq(Grid125.lowerBound(19), 1_000_000);
        assertEq(Grid125.lowerBound(1), 1);
    }

    function testFuzz_gridMonotone(uint256 a, uint256 b) public pure {
        a = bound(a, 0, 1e40);
        b = bound(b, 0, 1e40);
        if (a <= b) assertLe(Grid125.bucket(a), Grid125.bucket(b));
        else assertGe(Grid125.bucket(a), Grid125.bucket(b));
        uint32 i = Grid125.bucket(a);
        if (a != 0) {
            assertLe(Grid125.lowerBound(i), a);
            assertGt(Grid125.lowerBound(i + 1), a);
        }
    }

    function testFuzz_recordRoundTrip(TradeRecord.Fields memory f) public pure {
        uint256 w = TradeRecord.pack(f);
        TradeRecord.Fields memory g = TradeRecord.unpack(w);
        assertEq(keccak256(abi.encode(g)), keccak256(abi.encode(f)));
        assertEq(TradeRecord.isBuy(w), f.isBuy);
        assertEq(TradeRecord.label(w), f.label);
        assertEq(TradeRecord.labelFinal(w), f.labelFinal);
        assertEq(TradeRecord.positionId(w), f.positionId);
    }

    function test_labels() public pure {
        assertEq(TradeRecord.labelForHold(0), 100);
        assertEq(TradeRecord.labelForHold(10 minutes - 1), 100);
        assertEq(TradeRecord.labelForHold(10 minutes), 80);
        assertEq(TradeRecord.labelForHold(1 hours), 50);
        assertEq(TradeRecord.labelForHold(6 hours), 25);
        assertEq(TradeRecord.labelForHold(20 hours), 0);
    }

    function test_fees() public pure {
        // 1 ETH exact in at 2.3% total: fee 0.023
        assertEq(FeeCalc.onGross(1 ether, 23_000), 0.023 ether);
        // exact out: net 1 ETH, fee such that fee / (net + fee) = 2.3%
        uint256 f = FeeCalc.onNet(1 ether, 23_000);
        uint256 gross = 1 ether + f;
        assertApproxEqAbs(FeeCalc.onGross(gross, 23_000), f, 1);
        assertEq(FeeCalc.share(1 ether, 0.023 ether, 3_000), 0.003 ether);
        assertEq(FeeCalc.share(1 ether, 0.023 ether, 9_000), 0.009 ether);
    }
}
