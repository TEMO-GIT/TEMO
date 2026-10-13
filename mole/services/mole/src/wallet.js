import { randomBytes } from 'node:crypto';
import { toViemAccountSecure } from '@phala/dstack-sdk/viem';
import { verifyMessage } from 'viem';

// Only the service holds this object. Never serialize it or return it from an HTTP handler.
export async function loadWallet(client, keyPath, { transactions = false } = {}) {
  let material;
  try {
    material = await client.getKey(keyPath, 'wallet-signing', 'secp256k1');
    const account = toViemAccountSecure(material);
    const message = `TEMO wallet startup check. No authorization. Nonce: ${randomBytes(32).toString('hex')}`;
    const signature = await account.signMessage({ message });
    if (!await verifyMessage({ address: account.address, message, signature })) {
      throw new Error('Invalid signature');
    }
    return Object.freeze({
      address: account.address,
      signMessage: ({ message }) => account.signMessage({ message }),
      ...(transactions ? { signTransaction: transaction => account.signTransaction(transaction) } : {}),
    });
  } catch {
    throw new Error('Wallet initialization failed');
  } finally {
    material?.key?.fill(0);
  }
}
