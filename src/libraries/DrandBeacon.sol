// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Verifies drand "quicknet" beacons (scheme bls-unchained-g1-rfc9380) with the EIP-2537 precompiles.
///   - message   = sha256(round as 8-byte big-endian)
///   - signature = BLS on G1, public key on G2
///   - check     = e(H(m), pk) * e(sig, -G2) == 1
/// Signatures are passed uncompressed (x || y, 64-byte padded field elements each): the pairing precompile
/// rejects points that are not on the curve or not in the subgroup, so no decompression is needed on-chain.
library DrandBeacon {
    // precompiles (Prague)
    address private constant BLS_G1ADD = address(0x0b);
    address private constant BLS_PAIRING = address(0x0f);
    address private constant BLS_MAP_FP_TO_G1 = address(0x10);
    address private constant MODEXP = address(0x05);

    uint256 internal constant GENESIS = 1692803367;
    uint256 internal constant PERIOD = 3;

    bytes private constant DST = "BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_";

    // quicknet public key, G2, EIP-2537 encoding (x.c0, x.c1, y.c0, y.c1), 64-byte padded each
    bytes private constant PK =
        hex"000000000000000000000000000000000d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a"
        hex"0000000000000000000000000000000003cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d106451"
        hex"000000000000000000000000000000000e5db2b6bfbb01c867749cadffca88b36c24f3012ba09fc4d3022c5c37dce0f977d3adb5d183c7477c442b1f04515273"
        hex"0000000000000000000000000000000001a714f2edb74119a2f2b0d5a7c75ba902d163700a61bc224ededd8e63aef7be1aaf8e93d7a9718b047ccddb3eb5d68b";

    // -G2 generator (x unchanged, y negated mod p)
    bytes private constant NEG_G2 =
        hex"00000000000000000000000000000000024aa2b2f08f0a91260805272dc51051c6e47ad4fa403b02b4510b647ae3d1770bac0326a805bbefd48056c8c121bdb8"
        hex"0000000000000000000000000000000013e02b6052719f607dacd3a088274f65596bd0d09920b61ab5da61bbdc7f5049334cf11213945d57e5ac7d055d042b7e"
        hex"000000000000000000000000000000000d1b3cc2c7027888be51d9ef691d77bcb679afda66c73f17f9ee3837a55024f78c71363275a75d75d86bab79f74782aa"
        hex"0000000000000000000000000000000013fa4d4a0ad8b1ce186ed5061789213d993923066dddaf1040bc3ff59f825c78df74f2d75467e25e0f55f8a00fa030ed";

    bytes private constant FIELD_P =
        hex"1a0111ea397fe69a4b1ba7b6434bacd764774b84f38512bf6730d2a0f6b0f6241eabfffeb153ffffb9feffffffffaaab";

    error BadSignatureLength();
    error PrecompileFailed();

    /// @notice First round whose time is >= `timestamp`.
    function roundAt(uint256 timestamp) internal pure returns (uint64) {
        if (timestamp <= GENESIS) return 1;
        return uint64((timestamp - GENESIS + PERIOD - 1) / PERIOD + 1);
    }

    function roundTime(uint64 round) internal pure returns (uint256) {
        return GENESIS + (uint256(round) - 1) * PERIOD;
    }

    /// @notice True iff `sig` (128 bytes: x || y) is the quicknet signature of `round`.
    function verify(uint64 round, bytes memory sig) internal view returns (bool ok) {
        if (sig.length != 128) revert BadSignatureLength();
        bytes memory h = hashToG1(abi.encodePacked(sha256(abi.encodePacked(round))));
        bytes memory input = bytes.concat(h, PK, sig, NEG_G2);
        (bool success, bytes memory out) = BLS_PAIRING.staticcall(input);
        if (!success || out.length != 32) return false;
        ok = abi.decode(out, (uint256)) == 1;
    }

    /// @notice Randomness derived from a verified signature (unique per round: BLS signatures are deterministic).
    function randomness(bytes memory sig) internal pure returns (bytes32) {
        return keccak256(sig);
    }

    // ---------------- hash-to-curve, RFC 9380 BLS12381G1_XMD:SHA-256_SSWU_RO_ ----------------

    function hashToG1(bytes memory message) internal view returns (bytes memory point) {
        bytes memory uniform = expandMessageXmd(message, 128);
        bytes memory u0 = reduce(slice(uniform, 0, 64));
        bytes memory u1 = reduce(slice(uniform, 64, 64));
        bytes memory q0 = mapToG1(u0);
        bytes memory q1 = mapToG1(u1);
        (bool success, bytes memory out) = BLS_G1ADD.staticcall(bytes.concat(q0, q1));
        if (!success || out.length != 128) revert PrecompileFailed();
        point = out;
    }

    function expandMessageXmd(bytes memory message, uint256 lenInBytes) internal pure returns (bytes memory out) {
        uint256 ell = (lenInBytes + 31) / 32;
        bytes memory dstPrime = bytes.concat(DST, bytes1(uint8(DST.length)));
        bytes32 b0 = sha256(bytes.concat(new bytes(64), message, bytes2(uint16(lenInBytes)), bytes1(0), dstPrime));
        bytes32 bi = sha256(bytes.concat(b0, bytes1(uint8(1)), dstPrime));
        out = abi.encodePacked(bi);
        for (uint256 i = 2; i <= ell; ++i) {
            bi = sha256(bytes.concat(b0 ^ bi, bytes1(uint8(i)), dstPrime));
            out = bytes.concat(out, bi);
        }
        assembly ("memory-safe") {
            mstore(out, lenInBytes)
        }
    }

    /// @dev 64-byte big-endian integer mod p, returned as a 64-byte padded field element.
    function reduce(bytes memory x) internal view returns (bytes memory fe) {
        bytes memory input = bytes.concat(
            abi.encode(uint256(64)), abi.encode(uint256(1)), abi.encode(uint256(48)), x, bytes1(0x01), FIELD_P
        );
        (bool success, bytes memory out) = MODEXP.staticcall(input);
        if (!success || out.length != 48) revert PrecompileFailed();
        fe = bytes.concat(new bytes(16), out);
    }

    function mapToG1(bytes memory fe) internal view returns (bytes memory point) {
        (bool success, bytes memory out) = BLS_MAP_FP_TO_G1.staticcall(fe);
        if (!success || out.length != 128) revert PrecompileFailed();
        point = out;
    }

    function slice(bytes memory data, uint256 start, uint256 len) private pure returns (bytes memory out) {
        out = new bytes(len);
        for (uint256 i = 0; i < len; ++i) {
            out[i] = data[start + i];
        }
    }
}
