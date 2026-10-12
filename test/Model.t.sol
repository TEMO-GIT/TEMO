// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {TemoModel, WeightsStore} from "../src/TemoModel.sol";
import {TradeRecord} from "../src/libraries/TradeRecord.sol";
import {DrandBeacon} from "../src/libraries/DrandBeacon.sol";
import {IMoleProof, ITemoHook} from "../src/interfaces/ITemo.sol";

contract MockProof is IMoleProof {
    bool public proven;
    address public mole;

    constructor(address m) {
        mole = m;
    }

    function set(bool v) external {
        proven = v;
    }
}

/// @dev Stands in for the hook: a record list and closed positions.
contract MockHook {
    uint256[] public records;
    mapping(uint32 => uint256) public positions;
    address public burrow;
    uint40 public launchedAt = 1;

    function push(uint256 r) external {
        records.push(r);
    }

    function close(uint32 id, uint8 label) external {
        positions[id] = uint256(label) | (1 << 8);
    }

    function recordCount() external view returns (uint256) {
        return records.length;
    }
}

contract WeightsFactory {
    function make(bytes memory data) external returns (address) {
        return WeightsStore.create(data);
    }
}

contract ModelTest is Test {
    address mole = address(0xA11CE);
    MockProof proof;
    MockHook hook;
    WeightsFactory factory;
    TemoModel model;

    bytes constant SIG_1000 =
        hex"00000000000000000000000000000000144679b9a59af2ec876b1a6b1ad52ea9b1615fc3982b19576350f93447cb1125e342b73a8dd2bacbe47e4b6b63ed5e39"
        hex"0000000000000000000000000000000011f92e4521ef54f047b64b85fa98db2d46f0f44add1f60b93f8a0dbddd63b34f238657c2d93aed18b90bddd60a01b6d2";

    function setUp() public {
        proof = new MockProof(mole);
        hook = new MockHook();
        factory = new WeightsFactory();
        model = new TemoModel(mole, proof, factory.make(_zeroWeights()));
        vm.prank(mole);
        model.setHook(ITemoHook(address(hook)));
    }

    function _zeroWeights() internal pure returns (bytes memory) {
        return new bytes(177 * 2);
    }

    /// @dev All weights zero except the output bias: logits = bias/256.
    function _biasWeights(int16 bias) internal pure returns (bytes memory w) {
        w = new bytes(177 * 2);
        w[352] = bytes1(uint8(uint16(bias) >> 8));
        w[353] = bytes1(uint8(uint16(bias)));
    }

    function _sellRecord(uint8 label) internal pure returns (uint256) {
        TradeRecord.Fields memory f;
        f.isBuy = false;
        f.label = label;
        f.labelFinal = true;
        f.holdMinutes = 2000;
        return TradeRecord.pack(f);
    }

    function _buyRecord(uint32 pos) internal pure returns (uint256) {
        TradeRecord.Fields memory f;
        f.isBuy = true;
        f.positionId = pos;
        f.firstSeen = true;
        return TradeRecord.pack(f);
    }

    function test_zeroWeightsGiveMidScore() public view {
        assertEq(model.score(_sellRecord(0)), 5000);
        assertEq(model.score(_buyRecord(1)), 5000);
    }

    function test_biasMovesScore() public {
        address w = factory.make(_biasWeights(-1024)); // -4.0 -> 0
        assertEq(model.scoreWith(w, _sellRecord(0)), 0);
        w = factory.make(_biasWeights(1024)); // +4.0 -> 10000
        assertEq(model.scoreWith(w, _sellRecord(0)), 10000);
        w = factory.make(_biasWeights(-512)); // -2.0 -> 2500
        assertEq(model.scoreWith(w, _sellRecord(0)), 2500);
    }

    function test_inputsNormalized() public view {
        TradeRecord.Fields memory f;
        f.isBuy = true;
        f.sizeBps = 1023; // log2(1024) = 10 -> 160
        f.minutesSince = type(uint24).max; // capped 255
        f.tipGwei = 300; // capped 255
        f.trades24h = 7;
        f.hasCapsule = true;
        f.capsuleDays = 3; // 3*32+31 = 127
        f.firstSeen = true;
        int256[9] memory x = model.inputs(TradeRecord.pack(f));
        assertEq(x[0], 255);
        assertEq(x[1], 160);
        assertEq(x[2], 255);
        assertEq(x[3], 255);
        assertEq(x[4], 7);
        assertEq(x[5], 0);
        assertEq(x[6], 127);
        assertEq(x[7], 0);
        assertEq(x[8], 255);
    }

    function test_scoreGas() public {
        uint256 g = gasleft();
        model.score(_sellRecord(50));
        uint256 used = g - gasleft();
        assertLt(used, 60_000, "score must fit the hook's gas cap");
        emit log_named_uint("score gas", used);
    }

    function _fillRecords() internal {
        // 30 sells labeled "held" (0) and 10 buys, 5 of them with closed positions labeled 0, 5 still open
        for (uint256 i = 0; i < 30; ++i) hook.push(_sellRecord(0));
        for (uint32 i = 1; i <= 10; ++i) hook.push(_buyRecord(i));
        for (uint32 i = 1; i <= 5; ++i) hook.close(i, 0);
    }

    function _warpToRound1000Commit() internal {
        // commit at t such that roundAt(t + 60) == 1000, i.e. t + 60 == roundTime(1000)
        vm.warp(DrandBeacon.roundTime(1000) - 60);
    }

    function test_commitRequiresProof() public {
        _fillRecords();
        _warpToRound1000Commit();
        address w = factory.make(_biasWeights(-1024));
        vm.prank(mole);
        vm.expectRevert(TemoModel.NotProven.selector);
        model.commit(w);
    }

    function test_onlyMoleCommits() public {
        proof.set(true);
        _fillRecords();
        address w = factory.make(_biasWeights(-1024));
        vm.expectRevert(TemoModel.NotMole.selector);
        model.commit(w);
    }

    function test_judgeAdoptsBetterWeights() public {
        proof.set(true);
        _fillRecords();
        _warpToRound1000Commit();
        address better = factory.make(_biasWeights(-1024)); // scores 0 on everything; labels are 0 -> SSE 0
        vm.prank(mole);
        model.commit(better);
        (address pw,, uint64 round, uint256 frozen) = model.pending();
        assertEq(pw, better);
        assertEq(round, 1000);
        assertEq(frozen, 40);

        vm.expectRevert(TemoModel.TooEarlyToJudge.selector);
        model.judge(SIG_1000);

        vm.warp(DrandBeacon.roundTime(1000));
        vm.expectRevert(TemoModel.BadBeacon.selector);
        model.judge(new bytes(128));

        uint256 g = gasleft();
        model.judge(SIG_1000);
        emit log_named_uint("judge gas", g - gasleft());
        assertEq(model.weights(), better);
        assertEq(model.version(), 2);
    }

    function test_judgeRejectsWorseWeights() public {
        proof.set(true);
        _fillRecords();
        _warpToRound1000Commit();
        address worse = factory.make(_biasWeights(1024)); // scores 10000 on everything
        vm.prank(mole);
        model.commit(worse);
        vm.warp(DrandBeacon.roundTime(1000));
        model.judge(SIG_1000);
        assertEq(model.version(), 1);
        (address pw,,,) = model.pending();
        assertEq(pw, address(0));
    }

    function test_judgeRejectsTinyImprovement() public {
        proof.set(true);
        _fillRecords();
        _warpToRound1000Commit();
        // old = 5000 everywhere (SSE = n * 25e6); new = 4950 -> SSE = n * 24.5e6 = 98% -> not 3% better
        address almost = factory.make(_biasWeights(-10)); // -10/256*10000/8 ~ -48.8 -> 4951
        vm.prank(mole);
        model.commit(almost);
        vm.warp(DrandBeacon.roundTime(1000));
        model.judge(SIG_1000);
        assertEq(model.version(), 1);
    }

    function test_commitInterval() public {
        proof.set(true);
        _fillRecords();
        _warpToRound1000Commit();
        address w = factory.make(_biasWeights(-1024));
        vm.startPrank(mole);
        model.commit(w);
        vm.expectRevert(TemoModel.TooSoon.selector);
        model.commit(w);
        vm.stopPrank();
    }

    function test_judgeExpires() public {
        proof.set(true);
        _fillRecords();
        _warpToRound1000Commit();
        address w = factory.make(_biasWeights(-1024));
        vm.prank(mole);
        model.commit(w);
        vm.warp(block.timestamp + 2 days);
        model.judge(SIG_1000); // expired: dropped, no revert
        assertEq(model.version(), 1);
    }
}

