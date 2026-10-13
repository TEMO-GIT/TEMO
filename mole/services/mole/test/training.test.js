// DEV-ONLY: synthetic position data to exercise training policy, not a model quality claim.
import { test, expect } from 'bun:test';
import { trainCandidate, partitionExamples } from '../src/training.js';
import { decodeRecord } from '../src/contract-model.js';

function dataset(count = 80) {
  const rows = Array.from({ length: count }, (_, i) => ({ index: String(i),
    origin: `0x${(i + 1).toString(16).padStart(40, '0')}`, record: (1n | (BigInt(i + 1) << 132n)).toString() }));
  return { rows, examples: rows.map(row => ({ ...row, inputs: decodeRecord(row.record).inputs, target: 0 })) };
}
test('latest 20 percent groups are withheld and shared wallets are purged from training', () => {
  const d = dataset();
  let split = partitionExamples(d);
  expect(split.trainingGroups).toBe(64); expect(split.validationGroups).toBe(16);
  expect(split.validation[0].index).toBe('64');
  d.rows[0].origin = d.rows[79].origin;
  split = partitionExamples(d);
  expect(split.trainingGroups).toBe(63);
  expect(split.training.some(e => e.index === '0')).toBe(false);
});
test('an unresolved top-up excludes its entire group and small samples do not train', async () => {
  const d = dataset(10);
  const old = d.rows[0];
  d.rows.push({ ...old, index: '10' });
  expect(partitionExamples(d).training.some(e => e.index === '0')).toBe(false);
  const result = await trainCandidate({ dataset: d, currentWeights: Array(177).fill(0) });
  expect(result.status).toBe('insufficient_data');
  expect(result.weights).toBeUndefined();
});
test('deterministic training proposes only integer-validated improvements and keeps a perfect model', async () => {
  const d = dataset(), initial = Array(177).fill(0);
  const a = await trainCandidate({ dataset: d, currentWeights: initial });
  const b = await trainCandidate({ dataset: d, currentWeights: initial });
  expect(a.status).toBe('candidate'); expect(a.weightBytes).toBe(b.weightBytes);
  expect(BigInt(a.newValidationSse) * 100n <= BigInt(a.oldValidationSse) * 97n).toBe(true);
  const perfect = [...initial]; perfect[176] = -1024;
  const c = await trainCandidate({ dataset: d, currentWeights: perfect });
  expect(c.status).toBe('no_improvement'); expect(c.oldValidationSse).toBe('0');
  expect(initial.every(x => x === 0)).toBe(true);
});
