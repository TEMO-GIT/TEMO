import { isAddress, hexToBytes, padHex } from 'viem';

// Contract-compatible report data, separate from the development boot statement proof.
export function moleReportData(mole) {
  if (!isAddress(mole) || BigInt(mole) === 0n) {
    throw new Error('Nonzero mole address required');
  }
  // TemoModel 92510e9: uint160 address left-padded to 32 bytes, then 32 zero bytes.
  return `${padHex(mole.toLowerCase(), { size: 32 })}${'00'.repeat(32)}`;
}
export async function createContractQuote(client, mole) {
  const reportData = moleReportData(mole);
  const result = await client.getQuote(hexToBytes(reportData));
  if (!/^(0x)?[0-9a-f]+$/i.test(result.quote ?? '') || result.quote.replace(/^0x/, '').length % 2) throw new Error('Invalid TDX quote encoding');
  return { reportData, quote: `0x${result.quote.replace(/^0x/, '')}`, eventLog: result.event_log, contractVerified: false };
}
