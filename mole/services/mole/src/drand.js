import { createHash } from 'node:crypto';
import { bls12_381 } from '@noble/curves/bls12-381';

// quicknet parameters pinned against DrandBeacon.sol and the official beacon info response.
import { quicknet } from '../../../shared/quicknet.js';
export { quicknet } from '../../../shared/quicknet.js';
export function roundTime(round) {
  const n = BigInt(round);
  if (n < 1n || n >= 1n << 64n) throw new Error('Invalid drand round');
  return quicknet.genesis + (n - 1n) * quicknet.period;
}
export function verifyBeacon(beacon, expectedRound) {
  roundTime(expectedRound);
  if (!Number.isSafeInteger(beacon?.round) || BigInt(beacon.round) !== BigInt(expectedRound) ||
      !/^[0-9a-f]{96}$/i.test(beacon.signature ?? '')) throw new Error('Wrong drand response');
  const round = Buffer.alloc(8); round.writeBigUInt64BE(BigInt(expectedRound));
  const message = createHash('sha256').update(round).digest();
  if (!bls12_381.verifyShortSignature(beacon.signature, message, quicknet.publicKey,
    { DST: 'BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_' })) throw new Error('Invalid drand signature');
  const point = bls12_381.ShortSignature.fromHex(beacon.signature).toAffine();
  return `0x${point.x.toString(16).padStart(128, '0')}${point.y.toString(16).padStart(128, '0')}`;
}
export async function fetchBeacon(round, { fetchImpl = fetch, signal } = {}) {
  roundTime(round);
  // Pin the chain hash in the URL; the relay cannot choose a different beacon network.
  const response = await fetchImpl(`https://api.drand.sh/${quicknet.hash}/public/${round}`, {
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error('Drand round unavailable');
  const body = await response.text();
  if (body.length > 10000) throw new Error('Drand response too large');
  return verifyBeacon(JSON.parse(body), round);
}
