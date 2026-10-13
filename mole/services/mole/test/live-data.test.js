// DEV-ONLY: deterministic chain adapter fixtures; no real deployment or transaction submission.
import { test, expect } from 'bun:test';
import { readLiveDataset } from '../src/live-data.js';
import { hookAbi, modelAbi } from '../src/contract-abi.js';
import { encodeFunctionData, encodeEventTopics } from 'viem';

const hook = `0x${'11'.repeat(20)}`, origin = `0x${'22'.repeat(20)}`;
const hash = n => `0x${n.toString(16).padStart(64, '0')}`;
const buy = 1n | (1n << 132n), sell = (1n << 131n) | (80n << 123n);
function chain() {
  const state = { height: 12n, position: 0n, reorg: false, count: 2n, logs: [buy, sell].map((record, i) => ({
    address: hook, blockNumber: 10n + BigInt(i), blockHash: hash(10 + i), transactionHash: hash(100 + i),
    logIndex: 0, removed: false, args: { index: BigInt(i), origin, record, score: 5000 } })) };
  const reads = [];
  const client = {
    getChainId: async () => 1,
    getBlock: async ({ blockNumber }) => {
      const n = blockNumber ?? state.height;
      return { number: n, hash: hash(Number(n) + (state.reorg && n === 12n ? 100 : 0)), timestamp: n * 12n };
    },
    getCode: async () => '0x',
    getLogs: async ({ fromBlock, toBlock }) => state.logs.filter(l => l.blockNumber >= fromBlock && l.blockNumber <= toBlock),
    readContract: async request => {
      reads.push(request);
      return request.functionName === 'recordCount' ? state.count : state.position;
    },
  };
  return { state, client, reads };
}
test('reads all finalized TEMO history, resumes and adds a zero-label buy only after closure', async () => {
  const { client, state, reads } = chain();
  const previous = await readLiveDataset({ client, hook, deploymentBlock: 10n, blockBatch: 1 });
  expect(previous.rows.length).toBe(2);
  expect(previous.examples.map(x => x.target)).toEqual([8000]);
  expect(previous.pendingOrigins).toEqual([origin]);
  state.height = 13n; state.position = 256n;
  const next = await readLiveDataset({ client, hook, deploymentBlock: 10n, previous });
  expect(next.examples.map(x => x.target)).toEqual([0, 8000]);
  expect(next.pendingOrigins).toEqual([]);
  expect(previous.examples.length).toBe(1);
  expect(reads.filter(r => r.functionName === 'positions').map(r => r.blockNumber)).toEqual([12n, 13n]);
  expect(next.transactionsEnabled).toBe(false);
});
test('rejects event gaps, wrong chain and changed finalized checkpoints', async () => {
  const { client, state } = chain();
  const previous = await readLiveDataset({ client, hook, deploymentBlock: 10n });
  state.reorg = true;
  await expect(readLiveDataset({ client, hook, deploymentBlock: 10n, previous })).rejects.toThrow('Finalized checkpoint changed');
  state.reorg = false; state.logs.pop();
  await expect(readLiveDataset({ client, hook, deploymentBlock: 10n })).rejects.toThrow('Incomplete live trade history');
  client.getChainId = async () => 4663;
  await expect(readLiveDataset({ client, hook, deploymentBlock: 10n })).rejects.toThrow('requires Ethereum');
});
test('scoped ABI encodes contract update and settlement calls without signing', () => {
  expect(encodeFunctionData({ abi: modelAbi, functionName: 'commit', args: [hook] })).toMatch(/^0x[0-9a-f]{72}$/);
  expect(encodeFunctionData({ abi: hookAbi, functionName: 'settleMany', args: [[origin]] })).toMatch(/^0x/);
  expect(encodeEventTopics({ abi: hookAbi, eventName: 'Trade', args: { index: 0n, origin } }).length).toBe(3);
});
