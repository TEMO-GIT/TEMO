// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Website: <fill in before deploy>
// X:       <fill in before deploy>

import {ITemoHook, IMoleProof} from "./interfaces/ITemo.sol";
import {TradeRecord} from "./libraries/TradeRecord.sol";
import {DrandBeacon} from "./libraries/DrandBeacon.sol";

/// @title TemoModel
/// @notice A small neural net (9 inputs -> 16 hidden -> 1) whose weights live in a data contract. The hook asks it
///         for a dump score on every trade. Only the mole can propose new weights, and this contract judges them:
///  - commit: the mole names the new weights; the record count is frozen and a future drand round is fixed
///  - judge: anyone submits that round's beacon; the randomness samples finished records, both models are scored
///    on them, and the new weights are adopted only if their squared error is at least 3% lower
///  - weights can never be set any other way; there is no owner
contract TemoModel {
    using TradeRecord for uint256;

    uint256 public constant INPUTS = 9;
    uint256 public constant HIDDEN = 16;
    uint256 public constant WEIGHT_COUNT = INPUTS * HIDDEN + HIDDEN + HIDDEN + 1; // 177
    uint256 public constant WEIGHT_BYTES = WEIGHT_COUNT * 2;
    uint256 public constant SAMPLES = 48;
    uint256 public constant MIN_SAMPLES = 16;
    uint256 public constant MIN_IMPROVEMENT_PCT = 3;
    uint256 public constant COMMIT_INTERVAL = 20 hours;
    uint256 public constant JUDGE_DELAY = 60;
    uint256 public constant JUDGE_WINDOW = 1 days;

    address public immutable mole;
    IMoleProof public immutable moleProof;
    ITemoHook public hook; // set once by the mole after the hook exists

    address public weights;
    uint32 public version;

    struct Pending {
        address weights;
        uint40 committedAt;
        uint64 round;
        uint256 recordsFrozen;
    }

    Pending public pending;
    uint40 public lastCommitAt;

    error NotMole();
    error NotProven();
    error HookAlreadySet();
    error HookNotSet();
    error BadWeightsLength();
    error TooSoon();
    error NothingPending();
    error TooEarlyToJudge();
    error BadBeacon();
    error RecordsTooShort();

    event WeightsCommitted(address indexed weights, uint64 round, uint256 recordsFrozen);
    event WeightsJudged(address indexed weights, bool adopted, uint256 sseOld, uint256 sseNew, uint256 samples);
    event WeightsAdopted(address indexed weights, uint32 version);
    event HookSet(address hook);

    /// @param weights_ the v0 weights (WEIGHT_BYTES of int16), stored in a data contract created here
    constructor(address mole_, IMoleProof moleProof_, bytes memory weights_) {
        mole = mole_;
        moleProof = moleProof_;
        if (weights_.length != WEIGHT_BYTES) revert BadWeightsLength();
        address store = WeightsStore.create(weights_);
        weights = store;
        version = 1;
        emit WeightsAdopted(store, 1);
    }

    /// @notice One-shot wiring: only the mole, only once, only when the hook exists and points at this model.
    /// @notice One-shot binding, run by the launch graph: the hook must name this model.
    function setHook(ITemoHook hook_) external {
        if (address(hook) != address(0)) revert HookAlreadySet();
        if (address(hook_).code.length == 0 || hook_.model() != address(this)) revert HookNotSet();
        hook = hook_;
        emit HookSet(address(hook_));
    }

    // ================= scoring =================

    /// @notice Dump score of a packed record, 0..10000.
    function score(uint256 record) external view returns (uint16) {
        return _score(weights, record);
    }

    function scoreWith(address w, uint256 record) external view returns (uint16) {
        return _score(w, record);
    }

    /// @dev Inputs are the record fields normalized to 0..255 (log scales for sizes and times). Weights are int16
    ///      in Q8.8. Hidden layer ReLU, output through a hard sigmoid over logits in [-4, 4].
    function _score(address w, uint256 record) private view returns (uint16) {
        int256[INPUTS] memory x = _inputs(record);
        bytes memory wb = new bytes(WEIGHT_BYTES);
        assembly ("memory-safe") {
            extcodecopy(w, add(wb, 0x20), 0, mload(wb))
        }
        int256 out;
        assembly ("memory-safe") {
            let base := add(wb, 0x20)
            // int16 at weight index i: sign-extended top 2 bytes of the word at base + 2i
            function rd(b, i) -> v {
                v := signextend(1, shr(240, mload(add(b, mul(i, 2)))))
            }
            out := mul(rd(base, 176), 256) // output bias
            for { let j := 0 } lt(j, 16) { j := add(j, 1) } {
                let h := mul(rd(base, add(144, j)), 256) // hidden bias
                let row := mul(j, 9)
                for { let i := 0 } lt(i, 9) { i := add(i, 1) } {
                    h := add(h, mul(rd(base, add(row, i)), mload(add(x, mul(i, 0x20)))))
                }
                if sgt(h, 0) {
                    h := sdiv(h, 256)
                    out := add(out, mul(rd(base, add(160, j)), h))
                }
            }
            out := sdiv(out, 256)
        }
        // hard sigmoid: -4.0 -> 0, +4.0 -> 10000 (logits in Q8.8, 256 = 1.0)
        int256 s = (out + 1024) * 10000 / 2048;
        if (s < 0) return 0;
        if (s > 10000) return 10000;
        return uint16(uint256(s));
    }

    /// @notice Normalized inputs, public so the trainer can reproduce them exactly.
    function inputs(uint256 record) external pure returns (int256[INPUTS] memory) {
        return _inputs(record);
    }

    function _inputs(uint256 record) private pure returns (int256[INPUTS] memory x) {
        TradeRecord.Fields memory f = TradeRecord.unpack(record);
        x[0] = f.isBuy ? int256(255) : int256(0);
        x[1] = int256(_log2x16(f.sizeBps)); // 0..255
        x[2] = int256(_log2x16(f.minutesSince));
        x[3] = int256(uint256(f.tipGwei) > 255 ? 255 : uint256(f.tipGwei));
        x[4] = int256(uint256(f.trades24h) > 255 ? 255 : uint256(f.trades24h));
        x[5] = int256(_log2x16(f.holdMinutes));
        x[6] = f.hasCapsule ? int256(uint256(f.capsuleDays) * 32 + 31 > 255 ? 255 : uint256(f.capsuleDays) * 32 + 31) : int256(0);
        x[7] = int256(_log2x16(f.hourVolume));
        x[8] = f.firstSeen ? int256(255) : int256(0);
    }

    /// @dev 16 * floor(log2(v + 1)), capped at 255. log2 of a uint24 is at most 24 -> 16 * 24 = 384 -> capped.
    function _log2x16(uint256 v) private pure returns (uint256 r) {
        uint256 n = v + 1;
        uint256 l = 0;
        while (n > 1) {
            n >>= 1;
            ++l;
        }
        r = l * 16;
        if (r > 255) r = 255;
    }

    // ================= the judge =================

    /// @notice The mole names new weights. Freezes the record count and fixes the drand round of judgment.
    function commit(address newWeights) external {
        if (msg.sender != mole) revert NotMole();
        if (!moleProof.proven()) revert NotProven();
        if (address(hook) == address(0)) revert HookNotSet();
        if (newWeights.code.length != WEIGHT_BYTES) revert BadWeightsLength();
        if (block.timestamp < uint256(lastCommitAt) + COMMIT_INTERVAL) revert TooSoon();
        uint256 n = hook.recordCount();
        if (n < MIN_SAMPLES) revert RecordsTooShort();
        uint64 round = DrandBeacon.roundAt(block.timestamp + JUDGE_DELAY);
        pending = Pending({weights: newWeights, committedAt: uint40(block.timestamp), round: round, recordsFrozen: n});
        lastCommitAt = uint40(block.timestamp);
        emit WeightsCommitted(newWeights, round, n);
    }

    /// @notice Anyone brings the beacon of the committed round. Samples records, scores both models, decides.
    /// @param signature The round's BLS signature, uncompressed (x || y, 64 bytes each).
    function judge(bytes calldata signature) external {
        Pending memory p = pending;
        if (p.weights == address(0)) revert NothingPending();
        if (block.timestamp < DrandBeacon.roundTime(p.round)) revert TooEarlyToJudge();
        if (block.timestamp > uint256(p.committedAt) + JUDGE_WINDOW) {
            delete pending;
            emit WeightsJudged(p.weights, false, 0, 0, 0);
            return;
        }
        if (!DrandBeacon.verify(p.round, signature)) revert BadBeacon();
        bytes32 seed = DrandBeacon.randomness(signature);

        uint256 sseOld;
        uint256 sseNew;
        uint256 valid;
        address oldW = weights;
        for (uint256 k = 0; k < SAMPLES * 2 && valid < SAMPLES; ++k) {
            uint256 idx = uint256(keccak256(abi.encodePacked(seed, k))) % p.recordsFrozen;
            uint256 rec = hook.records(idx);
            (bool ok, uint256 label) = _finalLabel(rec);
            if (!ok) continue;
            ++valid;
            int256 target = int256(label * 100); // 0..10000
            int256 eOld = int256(uint256(_score(oldW, rec))) - target;
            int256 eNew = int256(uint256(_score(p.weights, rec))) - target;
            sseOld += uint256(eOld * eOld);
            sseNew += uint256(eNew * eNew);
        }
        delete pending;
        bool adopted = valid >= MIN_SAMPLES && sseNew * 100 <= sseOld * (100 - MIN_IMPROVEMENT_PCT);
        emit WeightsJudged(p.weights, adopted, sseOld, sseNew, valid);
        if (adopted) {
            weights = p.weights;
            ++version;
            emit WeightsAdopted(p.weights, version);
        }
    }

    /// @dev Sells carry their label; buys read the label of the position they belong to (0 = still open).
    function _finalLabel(uint256 rec) private view returns (bool ok, uint256 label) {
        if (rec.labelFinal()) return (true, rec.label());
        uint256 pos = hook.positions(rec.positionId());
        if (pos == 0) return (false, 0);
        return (true, pos & 0xff);
    }
}

/// @title WeightsStore
/// @notice Deploys a data contract whose runtime code is exactly the given weight bytes.
library WeightsStore {
    error DeployFailed();

    function create(bytes memory data) internal returns (address store) {
        // init code: copy `data` to memory and return it as the runtime code
        bytes memory code = bytes.concat(
            hex"61",
            bytes2(uint16(data.length)), // PUSH2 len
            hex"80600c6000396000f3", // DUP1 PUSH1 0x0c PUSH1 0 CODECOPY PUSH1 0 RETURN (12-byte init code)
            data
        );
        assembly ("memory-safe") {
            store := create(0, add(code, 0x20), mload(code))
        }
        if (store == address(0)) revert DeployFailed();
    }
}
