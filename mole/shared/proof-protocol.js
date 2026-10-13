import { isAddress } from 'viem';

export const PROOF_PROTOCOL = 'temo/public-attestation/v1';
export function cleanHex(value, bytes) {
  if (typeof value !== 'string') throw new Error('Hex value required');
  const hex = value.replace(/^0x/, '').toLowerCase();
  if (!/^(?:[0-9a-f]{2})*$/.test(hex) || (bytes !== undefined && hex.length !== bytes * 2)) {
    throw new Error('Invalid hex length or encoding');
  }
  return hex;
}
export const fromHex = value => Uint8Array.from(cleanHex(value).match(/../g) ?? [], byte => parseInt(byte, 16));
export const toHex = value => Array.from(value, byte => byte.toString(16).padStart(2, '0')).join('');
export async function digest(algorithm, bytes) {
  return new Uint8Array(await crypto.subtle.digest(algorithm, bytes));
}
export function joinBytes(...parts) {
  const result = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}
// Fixed, domain-separated format. The endpoint never quotes arbitrary caller-supplied report data.
export async function publicReportData({ nonce, walletAddress, appId, composeHash }) {
  if (!isAddress(walletAddress) || BigInt(walletAddress) === 0n) throw new Error('Nonzero wallet address required');
  const message = JSON.stringify([PROOF_PROTOCOL, cleanHex(nonce, 32), walletAddress.toLowerCase(),
    cleanHex(appId, 20), cleanHex(composeHash, 32)]);
  return `${toHex(await digest('SHA-256', new TextEncoder().encode(message)))}${'00'.repeat(32)}`;
}

export function canonicalTdQuote(raw) {
  const bytes = fromHex(raw);
  if (bytes.length < 636 || bytes.length > 65536) throw new Error('Invalid quote size');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(0, true) !== 4 || view.getUint16(2, true) !== 2 || view.getUint32(4, true) !== 0x81) {
    throw new Error('TDX v4 ECDSA quote required');
  }
  const length = 636 + view.getUint32(632, true);
  if (length <= 636 || length > bytes.length || bytes.slice(length).some(byte => byte !== 0)) {
    throw new Error('Invalid quote signature length');
  }
  return bytes.slice(0, length);
}
