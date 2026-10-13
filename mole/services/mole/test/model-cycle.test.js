// DEV-ONLY: end-to-end read-only rehearsal against a deterministic contract client.
import { test, expect } from 'bun:test';
import { rehearseModelCycle } from '../src/model-cycle.js';
import { encodeWeights } from '../src/contract-model.js';

const address = n => `0x${n.toString(16).padStart(40, '0')}`;
const hash = n => `0x${n.toString(16).padStart(64, '0')}`;
function fixture() {
  const hook = address(1), model = address(2), weights = address(3);
  const state = { pending: [address(0), 0, 0n, 0n], remoteScore: 5000, boundHook: hook };
  const logs = Array.from({ length: 80 }, (_, i) => ({ address: hook, blockNumber: BigInt(10 + i),
    blockHash: hash(10 + i), transactionHash: hash(1000 + i), logIndex: 0, removed: false,
    args: { index: BigInt(i), origin: address(100 + i), record: 1n | (BigInt(i + 1) << 132n), score: 5000 } }));
  const client = {
    getChainId: async () => 1,
    getBlock: async ({ blockNumber }) => ({ number: blockNumber ?? 100n, hash: hash(Number(blockNumber ?? 100n)), timestamp: 200000n }),
    getCode: async ({ address: a }) => a === weights ? encodeWeights(Array(177).fill(0)) : '0x',
    getLogs: async ({ fromBlock, toBlock }) => logs.filter(l => l.blockNumber >= fromBlock && l.blockNumber <= toBlock),
    readContract: async ({ functionName }) => {
      const responses = { model, hook: state.boundHook, weights, pending: state.pending,
        lastCommitAt: 0, version: 1, recordCount: 80n, positions: 256n, scoreWith: state.remoteScore };
      if (!(functionName in responses)) throw new Error('Unexpected function');
      return responses[functionName];
    },
  };
  return { client, state, hook, deploymentBlock: 10n };
}
test('full rehearsal reads, trains, validates and saves a candidate without any send interface', async () => {
  const f = fixture();
  const result = await rehearseModelCycle(f);
  expect(result.status).toBe('candidate');
  expect(result.arithmeticChecks).toBe(8);
  expect(result.publication).toBe('not_submitted');
  expect(result.transactionsEnabled).toBe(false);
  expect(result.dataset.examples.length).toBe(80);
  const resumed = await rehearseModelCycle({ ...f, previousDataset: result.dataset, previousAttemptAt: result.attemptAt });
  expect(resumed.status).toBe('daily_cooldown');
});
test('pending judgment, deployed arithmetic mismatch and wrong model bindings prevent a proposal', async () => {
  const f = fixture();
  f.state.pending = [address(4), 190000, 10n, 80n];
  expect((await rehearseModelCycle(f)).status).toBe('pending_contract_judgment');
  f.state.remoteScore = 5001;
  await expect(rehearseModelCycle(f)).rejects.toThrow('arithmetic differs');
  f.state.remoteScore = 5000; f.state.boundHook = address(9);
  await expect(rehearseModelCycle(f)).rejects.toThrow('binding mismatch');
});
