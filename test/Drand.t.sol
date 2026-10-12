// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {DrandBeacon} from "../src/libraries/DrandBeacon.sol";

contract DrandHarness {
    function verify(uint64 round, bytes memory sig) external view returns (bool) {
        return DrandBeacon.verify(round, sig);
    }

    function hashToG1(bytes memory m) external view returns (bytes memory) {
        return DrandBeacon.hashToG1(m);
    }
}

contract DrandTest is Test {
    DrandHarness h;

    // quicknet round 1000, signature decompressed to (x, y)
    bytes constant SIG_1000 =
        hex"00000000000000000000000000000000144679b9a59af2ec876b1a6b1ad52ea9b1615fc3982b19576350f93447cb1125e342b73a8dd2bacbe47e4b6b63ed5e39"
        hex"0000000000000000000000000000000011f92e4521ef54f047b64b85fa98db2d46f0f44add1f60b93f8a0dbddd63b34f238657c2d93aed18b90bddd60a01b6d2";
    // quicknet round 33007547
    bytes constant SIG_LATE =
        hex"00000000000000000000000000000000005a49b3e3e4c5deeb4b789e5b6679b5d7e4014c67bfe48a9adbe1eba580c98539159c2d54489d6563ca2a1381e33b56"
        hex"0000000000000000000000000000000004a5d07ab7907341773ec174759f07005d779b0d357ef8f6f4f296644c2eb92806988afe37475eb8165c6d0843359942";

    function setUp() public {
        h = new DrandHarness();
    }

    function test_verifyRound1000() public view {
        assertTrue(h.verify(1000, SIG_1000), "round 1000 must verify");
    }

    function test_verifyLateRound() public view {
        assertTrue(h.verify(33007547, SIG_LATE), "round 33007547 must verify");
    }

    function test_wrongRoundFails() public view {
        assertFalse(h.verify(1001, SIG_1000));
        assertFalse(h.verify(1000, SIG_LATE));
    }

    function test_garbageFails() public view {
        bytes memory junk = new bytes(128);
        junk[127] = 0x01;
        assertFalse(h.verify(1000, junk));
    }

    function test_roundAt() public pure {
        assertEq(DrandBeacon.roundAt(DrandBeacon.GENESIS), 1);
        assertEq(DrandBeacon.roundAt(DrandBeacon.GENESIS + 1), 2);
        assertEq(DrandBeacon.roundAt(DrandBeacon.GENESIS + 3), 2);
        assertEq(DrandBeacon.roundAt(DrandBeacon.GENESIS + 4), 3);
        assertEq(DrandBeacon.roundTime(1000), DrandBeacon.GENESIS + 999 * 3);
    }

    function test_gasOfVerify() public view {
        uint256 g = gasleft();
        h.verify(1000, SIG_1000);
        uint256 used = g - gasleft();
        assertLt(used, 400_000, "verify should stay well under 400k gas");
    }
}
