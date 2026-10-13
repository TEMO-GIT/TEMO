import { Buffer, timelockEncrypt, timelockDecrypt } from 'tlock-js';
// These parsers are part of the pinned tlock-js 0.9.0 package.
import { decodeArmor } from 'tlock-js/age/armor.js';
import { readAge } from 'tlock-js/age/age-reader-writer.js';
import { encodeAbiParameters, isAddress, keccak256 } from 'viem';
import { capsuleRound, quicknet } from './quicknet.js';

export { capsuleRound } from './quicknet.js';
export const CAPSULE_VERSION = 1;
export const MAX_CAPSULE_BYTES = 8192;
const chainInfo = Object.freeze({ hash: quicknet.hash, public_key: quicknet.publicKey,
  genesis_time: Number(quicknet.genesis), period: Number(quicknet.period), schemeID: 'bls-unchained-g1-rfc9380' });

function chainClient({ fetchImpl = fetch, signal } = {}) {
  return {
    options: { disableBeaconVerification: false, noCache: true },
    chain: () => ({ info: async () => chainInfo }),
    async get(round) {
      const timeout = AbortSignal.timeout(15000);
      const response = await fetchImpl(`https://api.drand.sh/${quicknet.hash}/public/${round}`, {
        redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      if (!response.ok) throw new Error('Drand round unavailable');
      const body = await response.text();
      if (body.length > 10000) throw new Error('Drand response too large');
      return JSON.parse(body);
    },
  };
}

function validateOpening(answers, salt) {
  if (!Array.isArray(answers) || answers.length !== 9 ||
      answers.some(x => !Number.isInteger(x) || x < 0 || x > 255)) throw new Error('Expected nine uint8 answers');
  if (!/^0x[0-9a-f]{64}$/i.test(salt ?? '')) throw new Error('Expected bytes32 capsule salt');
}

export function capsuleCommit({ owner, season, answers, salt }) {
  validateOpening(answers, salt);
  if (!isAddress(owner) || !Number.isSafeInteger(season) || season < 0 || season > 0xffffffff) {
    throw new Error('Invalid capsule owner or season');
  }
  return keccak256(encodeAbiParameters([
    { type: 'address' }, { type: 'uint32' }, { type: 'uint8[9]' }, { type: 'bytes32' },
  ], [owner, season, answers, salt]));
}

export function newCapsuleSalt() {
  return `0x${Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(32))).toString('hex')}`;
}

function envelopeBytes(ciphertext) {
  if (typeof ciphertext !== 'string' || ciphertext.length > 2 + 2 * MAX_CAPSULE_BYTES ||
      !/^0x(?:[0-9a-f]{2})+$/i.test(ciphertext)) throw new Error('Invalid capsule encoding');
  const bytes = Buffer.from(ciphertext.slice(2), 'hex');
  if (bytes.length < 10 || bytes[0] !== CAPSULE_VERSION) throw new Error('Unsupported capsule version');
  return bytes;
}

export function inspectCapsule(ciphertext, seasonEnd) {
  const bytes = envelopeBytes(ciphertext);
  const round = bytes.readBigUInt64BE(1);
  if (round !== capsuleRound(seasonEnd)) throw new Error('Capsule unlock round mismatch');
  const age = bytes.subarray(9).toString('binary');
  const { header } = readAge(age);
  const recipient = header.recipients[0];
  // tlock-js does not itself enforce the chain hash written in the AGE stanza.
  if (header.version !== 'age-encryption.org/v1' || header.recipients.length !== 1 ||
      recipient.type !== 'tlock' || recipient.args.length !== 2 ||
      recipient.args[0] !== round.toString() || recipient.args[1] !== quicknet.hash) {
    throw new Error('Capsule encryption binding mismatch');
  }
  return { version: CAPSULE_VERSION, round: round.toString(), age };
}

export async function encryptCapsule({ owner, season, seasonEnd, answers, salt = newCapsuleSalt() }) {
  const commit = capsuleCommit({ owner, season, answers, salt });
  const round = capsuleRound(seasonEnd);
  const plaintext = Buffer.concat([Buffer.from(answers), Buffer.from(salt.slice(2), 'hex')]);
  const armored = await timelockEncrypt(Number(round), plaintext, chainClient());
  const header = Buffer.alloc(9); header[0] = CAPSULE_VERSION; header.writeBigUInt64BE(round, 1);
  const ciphertext = `0x${Buffer.concat([header, Buffer.from(decodeArmor(armored), 'binary')]).toString('hex')}`;
  inspectCapsule(ciphertext, seasonEnd);
  // The caller keeps the opening locally; only commit and ciphertext are submitted on-chain.
  return { commit, ciphertext, answers: [...answers], salt, round: round.toString() };
}

export async function decryptCapsule({ ciphertext, seasonEnd, owner, season, commit }, options = {}) {
  const { age } = inspectCapsule(ciphertext, seasonEnd);
  const plaintext = await timelockDecrypt(age, chainClient(options));
  if (plaintext.length !== 41) throw new Error('Invalid capsule plaintext length');
  const opening = { answers: Array.from(plaintext.subarray(0, 9)), salt: `0x${plaintext.subarray(9).toString('hex')}` };
  if (!/^0x[0-9a-f]{64}$/i.test(commit ?? '') ||
      capsuleCommit({ owner, season, ...opening }) !== commit.toLowerCase()) throw new Error('Capsule commitment mismatch');
  return opening;
}
