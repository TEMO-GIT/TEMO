// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice One trade, packed in one storage word. Written by the hook, read by the model and its judge.
/// Layout (LSB first):
///   bit   0        isBuy
///   bits  1..16    sizeBps        trade ETH / pool ETH reserve, in bps (cap 65535)
///   bits 17..40    minutesSince   minutes since launch (cap 2^24-1)
///   bits 41..56    tipGwei        tx.gasprice - basefee, in gwei (cap 65535)
///   bits 57..72    trades24h      trades by this origin in the trailing 24 h window (cap 65535)
///   bits 73..96    holdMinutes    minutes since the open position was opened (sells; 0 on buys)
///   bits 97..104   capsuleDays    age of the origin's capsule in days (cap 255)
///   bit 105        hasCapsule
///   bits 106..121  hourVolume     ETH traded in the current hour, in 0.01 ETH units (cap 65535)
///   bit 122        firstSeen      the hook had never seen this origin before this trade
///   bits 123..130  label          0..100 (= 0.00..1.00); meaningful only when labelFinal = 1
///   bit 131        labelFinal     1: label is in this word (sells); 0: label lives in positions[positionId]
///   bits 132..163  positionId     the origin's open position this buy belongs to (buys only)
library TradeRecord {
    uint256 internal constant LABEL_SCALE = 100;

    struct Fields {
        bool isBuy;
        uint16 sizeBps;
        uint24 minutesSince;
        uint16 tipGwei;
        uint16 trades24h;
        uint24 holdMinutes;
        uint8 capsuleDays;
        bool hasCapsule;
        uint16 hourVolume;
        bool firstSeen;
        uint8 label;
        bool labelFinal;
        uint32 positionId;
    }

    function pack(Fields memory f) internal pure returns (uint256 w) {
        w = f.isBuy ? 1 : 0;
        w |= uint256(f.sizeBps) << 1;
        w |= uint256(f.minutesSince) << 17;
        w |= uint256(f.tipGwei) << 41;
        w |= uint256(f.trades24h) << 57;
        w |= uint256(f.holdMinutes) << 73;
        w |= uint256(f.capsuleDays) << 97;
        w |= (f.hasCapsule ? uint256(1) : 0) << 105;
        w |= uint256(f.hourVolume) << 106;
        w |= (f.firstSeen ? uint256(1) : 0) << 122;
        w |= uint256(f.label) << 123;
        w |= (f.labelFinal ? uint256(1) : 0) << 131;
        w |= uint256(f.positionId) << 132;
    }

    function unpack(uint256 w) internal pure returns (Fields memory f) {
        f.isBuy = w & 1 == 1;
        f.sizeBps = uint16(w >> 1);
        f.minutesSince = uint24(w >> 17);
        f.tipGwei = uint16(w >> 41);
        f.trades24h = uint16(w >> 57);
        f.holdMinutes = uint24(w >> 73);
        f.capsuleDays = uint8(w >> 97);
        f.hasCapsule = (w >> 105) & 1 == 1;
        f.hourVolume = uint16(w >> 106);
        f.firstSeen = (w >> 122) & 1 == 1;
        f.label = uint8(w >> 123);
        f.labelFinal = (w >> 131) & 1 == 1;
        f.positionId = uint32(w >> 132);
    }

    function isBuy(uint256 w) internal pure returns (bool) {
        return w & 1 == 1;
    }

    function labelFinal(uint256 w) internal pure returns (bool) {
        return (w >> 131) & 1 == 1;
    }

    function label(uint256 w) internal pure returns (uint8) {
        return uint8(w >> 123);
    }

    function positionId(uint256 w) internal pure returns (uint32) {
        return uint32(w >> 132);
    }

    /// @notice Role label by hold time, as a percentage: bot 100, flipper 80, trader 50, strategist 25, holder 0.
    function labelForHold(uint256 holdSeconds) internal pure returns (uint8) {
        if (holdSeconds < 10 minutes) return 100;
        if (holdSeconds < 1 hours) return 80;
        if (holdSeconds < 6 hours) return 50;
        if (holdSeconds < 20 hours) return 25;
        return 0;
    }

    function clamp16(uint256 v) internal pure returns (uint16) {
        return v > type(uint16).max ? type(uint16).max : uint16(v);
    }

    function clamp24(uint256 v) internal pure returns (uint24) {
        return v > type(uint24).max ? type(uint24).max : uint24(v);
    }

    function clamp8(uint256 v) internal pure returns (uint8) {
        return v > type(uint8).max ? type(uint8).max : uint8(v);
    }
}
