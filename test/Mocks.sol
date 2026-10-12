// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IDcapAttestation} from "../src/interfaces/ITemo.sol";

/// @dev Stands in for the Automata verifier: returns a prepared serialized output for any quote.
contract MockVerifier is IDcapAttestation {
    bytes public output;
    bool public ok = true;

    function set(bytes memory out, bool ok_) external {
        output = out;
        ok = ok_;
    }

    function verifyAndAttestOnChain(bytes calldata) external payable returns (bool, bytes memory) {
        return (ok, output);
    }
}

// Builds the verifier output the way the model parses it:
// version(2) bodyType(2) tcbStatus(1) fmspc(6) + TD10 body (584): MRTD at 136 (48 bytes), RTMR0..3 at 328 (192),
// reportData at 520 (64). `mrtd` and `rtmrs` are the raw measurement bytes.
library QuoteOut {
    function build(uint16 bodyType, uint8 tcb, bytes memory mrtd, bytes memory rtmrs, bytes memory reportData)
        internal
        pure
        returns (bytes memory out)
    {
        require(mrtd.length == 48 && rtmrs.length == 192 && reportData.length == 64, "lengths");
        out = new bytes(11 + 584);
        out[0] = 0x00;
        out[1] = 0x04;
        out[2] = bytes1(uint8(bodyType >> 8));
        out[3] = bytes1(uint8(bodyType));
        out[4] = bytes1(tcb);
        for (uint256 i = 0; i < 6; ++i) out[5 + i] = bytes1(uint8(0xA0 + i));
        for (uint256 i = 0; i < 48; ++i) out[11 + 136 + i] = mrtd[i];
        for (uint256 i = 0; i < 192; ++i) out[11 + 328 + i] = rtmrs[i];
        for (uint256 i = 0; i < 64; ++i) out[11 + 520 + i] = reportData[i];
    }

    function measurements(bytes32 seed) internal pure returns (bytes memory mrtd, bytes memory rtmrs) {
        mrtd = abi.encodePacked(keccak256(abi.encode(seed, "mrtd")), bytes16(keccak256(abi.encode(seed, "mrtd2"))));
        rtmrs = abi.encodePacked(
            keccak256(abi.encode(seed, 0)), keccak256(abi.encode(seed, 1)), keccak256(abi.encode(seed, 2)),
            keccak256(abi.encode(seed, 3)), keccak256(abi.encode(seed, 4)), keccak256(abi.encode(seed, 5))
        );
    }

    function reportFor(address mole) internal pure returns (bytes memory) {
        return abi.encodePacked(bytes32(uint256(uint160(mole))), bytes32(0));
    }
}
