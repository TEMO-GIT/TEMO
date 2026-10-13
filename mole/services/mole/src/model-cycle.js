import { isAddress } from 'viem';
import { readLiveDataset } from './live-data.js';
import { hookAbi, modelAbi } from './contract-abi.js';
import { decodeWeights, scoreRecord } from './contract-model.js';
import { trainCandidate, trainingPolicy } from './training.js';

// Read-only cycle. Publication remains a separate transaction workflow requiring deployed roles.
export async function rehearseModelCycle({ client, hook, deploymentBlock, previousDataset,
  previousAttemptAt = null, signal, train = trainCandidate }) {
  const dataset = await readLiveDataset({ client, hook, deploymentBlock, previous: previousDataset, signal });
  const blockNumber = BigInt(dataset.block.number);
  const model = await client.readContract({ address: hook, abi: hookAbi, functionName: 'model', blockNumber });
  if (!isAddress(model) || BigInt(model) === 0n) throw new Error('Hook model is not configured');
  const read = functionName => client.readContract({ address: model, abi: modelAbi, functionName, blockNumber });
  const [boundHook, weightsAddress, pending, lastCommitAt, version] = await Promise.all([
    read('hook'), read('weights'), read('pending'), read('lastCommitAt'), read('version'),
  ]);
  if (boundHook.toLowerCase() !== hook.toLowerCase()) throw new Error('Model hook binding mismatch');
  const code = await client.getCode({ address: weightsAddress, blockNumber }), currentWeights = decodeWeights(code);
  const sample = [...new Set([...dataset.rows.slice(0, 4), ...dataset.rows.slice(-4)])];
  for (const row of sample) {
    signal?.throwIfAborted();
    const remote = await client.readContract({ address: model, abi: modelAbi, functionName: 'scoreWith',
      args: [weightsAddress, BigInt(row.record)], blockNumber });
    if (Number(remote) !== scoreRecord(currentWeights, row.record)) throw new Error('Deployed model arithmetic differs from local baseline');
  }
  const now = BigInt(dataset.block.timestamp), commitAfter = BigInt(lastCommitAt) + 72000n;
  const report = { mode: 'read_only_rehearsal', transactionsEnabled: false, dataset,
    model: { address: model, weightsAddress, version: Number(version), weightBytes: code },
    arithmeticChecks: sample.length, attemptAt: previousAttemptAt };
  if (BigInt(pending[0]) !== 0n) return { ...report, status: 'pending_contract_judgment',
    pending: { weightsAddress: pending[0], committedAt: pending[1].toString(), round: pending[2].toString(), recordsFrozen: pending[3].toString() } };
  if (now < commitAfter) return { ...report, status: 'contract_cooldown', nextAttemptAt: commitAfter.toString() };
  if (previousAttemptAt !== null && now < BigInt(previousAttemptAt) + BigInt(trainingPolicy.scheduleSeconds)) {
    return { ...report, status: 'daily_cooldown', nextAttemptAt: (BigInt(previousAttemptAt) + BigInt(trainingPolicy.scheduleSeconds)).toString() };
  }
  const result = await train({ dataset, currentWeights, signal });
  const anchor = await client.getBlock({ blockNumber });
  if (anchor.hash !== dataset.block.hash) throw new Error('Finalized snapshot changed during training');
  return { ...report, status: result.status, attemptAt: now.toString(), training: result,
    publication: result.status === 'candidate' ? 'not_submitted' : 'not_required' };
}
