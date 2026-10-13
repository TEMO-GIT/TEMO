import { isAbsolute } from 'node:path';
import { isAddress } from 'viem';
import { contractRevision } from '../src/contract-model.js';
import { validateGasPolicy } from '../src/transaction-executor.js';

export function validateExecutionConfig(config) {
  if (config.verificationMode !== 'offchain-phala' || config.contractRevision !== contractRevision ||
      ['verifier', 'mrTdHash', 'rtmrHash', 'verifierFeeWei', 'proof'].some(key => config[key] !== undefined)) {
    throw new Error('Current off-chain execution configuration required');
  }
  if (config.chainId !== 1 || typeof config.deploymentBlock !== 'string' || !/^[1-9][0-9]*$/.test(config.deploymentBlock) ||
      !isAbsolute(config.storePath ?? '') || typeof config.transactionsEnabled !== 'boolean') {
    throw new Error('Execution configuration incomplete');
  }
  for (const key of ['hook', 'model', 'burrow', 'token', 'graphFactory']) {
    if (!isAddress(config[key]) || BigInt(config[key]) === 0n) throw new Error('Complete launch graph required');
  }
  for (const key of ['hook', 'model', 'burrow', 'token']) {
    if (!/^0x[0-9a-f]{64}$/i.test(config.codeHashes?.[key] ?? '')) throw new Error('Runtime hashes required');
  }
  if (config.transactionsEnabled) validateGasPolicy(config.gasPolicy);
  return config;
}
