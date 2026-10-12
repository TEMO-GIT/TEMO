// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Website: <fill in before deploy>
// X:       <fill in before deploy>

import {IDcapAttestation} from "./interfaces/ITemo.sol";

/// @title MoleProof
/// @notice Proves, in this contract, that the mole's wallet was born inside a sealed TDX machine running a known
///         image. One call, once. The model and the burrow refuse the mole until `proven`.
///  - the quote is verified by the public Automata DCAP verifier (signature chain up to Intel, TCB status)
///  - this contract then pins the measurements: MRTD and RTMR0..3 must equal the values fixed at deployment,
///    and the quote's report data must equal keccak256(mole wallet, capsule public key)
///  - what to compare the measurements against (image hash, compose hash) is published with the mole's code
contract MoleProof {
    address public immutable mole;
    IDcapAttestation public immutable verifier;
    bytes32 public immutable mrTdHash; // keccak256 of the 48-byte MRTD
    bytes32 public immutable rtmrHash; // keccak256 of RTMR0 || RTMR1 || RTMR2 || RTMR3 (192 bytes)

    bool public proven;
    bytes6 public fmspc;
    uint8 public tcbStatus;

    // serialized verifier output: version(2) bodyType(2) tcbStatus(1) fmspc(6) then the raw TD10 body (584)
    uint256 private constant OUT_BODY = 11;
    uint256 private constant TD10_LEN = 584;
    uint256 private constant TD10_MRTD = 136;
    uint256 private constant TD10_RTMR0 = 328;
    uint256 private constant TD10_REPORT_DATA = 520;
    uint16 private constant TD10_BODY_TYPE = 2;
    uint8 private constant TCB_MAX_ACCEPTED = 1; // OK or SW_HARDENING_NEEDED

    error NotMole();
    error AlreadyProven();
    error VerifierRejected();
    error WrongBodyType();
    error TcbNotAccepted(uint8 status);
    error WrongMeasurement();
    error WrongReportData();
    error ZeroAddress();

    event MoleProven(address indexed mole, bytes6 fmspc, uint8 tcbStatus);

    constructor(address mole_, IDcapAttestation verifier_, bytes32 mrTdHash_, bytes32 rtmrHash_) {
        if (mole_ == address(0) || address(verifier_) == address(0)) revert ZeroAddress();
        mole = mole_;
        verifier = verifier_;
        mrTdHash = mrTdHash_;
        rtmrHash = rtmrHash_;
    }

    /// @notice Submit the raw TDX quote. Payable: the verifier may charge a gas-proportional fee and refunds the rest
    ///         to tx.origin.
    function proveMole(bytes calldata rawQuote) external payable {
        if (msg.sender != mole) revert NotMole();
        if (proven) revert AlreadyProven();

        (bool ok, bytes memory out) = verifier.verifyAndAttestOnChain{value: msg.value}(rawQuote);
        if (!ok || out.length < OUT_BODY + TD10_LEN) revert VerifierRejected();

        uint16 bodyType = (uint16(uint8(out[2])) << 8) | uint16(uint8(out[3]));
        if (bodyType != TD10_BODY_TYPE) revert WrongBodyType();
        uint8 status = uint8(out[4]);
        if (status > TCB_MAX_ACCEPTED) revert TcbNotAccepted(status);

        if (keccak256(_slice(out, OUT_BODY + TD10_MRTD, 48)) != mrTdHash) revert WrongMeasurement();
        if (keccak256(_slice(out, OUT_BODY + TD10_RTMR0, 192)) != rtmrHash) revert WrongMeasurement();

        bytes memory reportData = _slice(out, OUT_BODY + TD10_REPORT_DATA, 64);
        bytes32 expected = bytes32(uint256(uint160(mole))); // report data = the mole's address, left-padded
        if (bytes32(_slice(reportData, 0, 32)) != expected || bytes32(_slice(reportData, 32, 32)) != bytes32(0)) {
            revert WrongReportData();
        }

        bytes6 f;
        assembly ("memory-safe") {
            f := mload(add(out, add(0x20, 5)))
        }
        fmspc = f;
        tcbStatus = status;
        proven = true;
        emit MoleProven(mole, f, status);
    }

    function _slice(bytes memory data, uint256 start, uint256 len) private pure returns (bytes memory out) {
        out = new bytes(len);
        for (uint256 i = 0; i < len; ++i) {
            out[i] = data[start + i];
        }
    }
}
