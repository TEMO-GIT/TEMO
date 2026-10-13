// DEV-ONLY: deterministic model arithmetic and synthetic live-record cases; no RPC or funds.
import { test, expect } from 'bun:test';
import { encodeWeights, decodeWeights, scoreInputs, scoreRecord, decodeRecord, finalizedTarget,
  squaredError } from '../src/contract-model.js';
import { packFeatureRecord } from '../../../scripts/data/trade-features.js';

const fields = { isBuy: true, sizeBps: 1023, minutesSince: 16777215, tipGwei: 300,
  trades24h: 7, holdMinutes: 0, hasCapsule: true, capsuleDays: 3, hourVolume: 0, firstSeen: true };
const buy = packFeatureRecord(fields) | (1n << 132n);
const zero = () => Array(177).fill(0);

test('contract test vectors: normalization, zero weights and output bias', () => {
  expect(decodeRecord(buy).inputs).toEqual([255, 160, 255, 255, 7, 0, 127, 0, 255]);
  for (const [bias, expected] of [[0, 5000], [-1024, 0], [1024, 10000], [-512, 2500]]) {
    const w = zero(); w[176] = bias;
    expect(scoreRecord(w, buy)).toBe(expected);
  }
});
test('int16 bytes preserve signed boundaries and reject malformed model stores', () => {
  const w = zero(); w[0] = -32768; w[1] = 32767; w[2] = -1;
  const bytes = encodeWeights(w);
  expect(bytes.slice(0, 14)).toBe('0x80007fffffff');
  expect(decodeWeights(bytes)).toEqual(w);
  expect(() => decodeWeights(`${bytes}00`)).toThrow();
  w[0] = 32768; expect(() => encodeWeights(w)).toThrow();
});
test('hidden rounding and negative output division match EVM truncation, not floor', () => {
  const w = zero(), x = Array(9).fill(0);
  x[0] = 255; w[0] = 1; w[144] = 1; w[160] = -257;
  // Hidden: floor((256+255)/256)=1; output trunc(-257/256)=-1; score=4995.
  expect(scoreInputs(w, x)).toBe(4995);
  w[144] = -1; // ReLU removes the negative neuron.
  expect(scoreInputs(w, x)).toBe(5000);
  expect(() => scoreInputs(w, x.map(() => null))).toThrow();
});
test('labels distinguish a held closed position from an unresolved buy', () => {
  expect(finalizedTarget(buy, 0n)).toBeNull();
  expect(finalizedTarget(buy, 256n)).toBe(0);
  expect(finalizedTarget(buy, 256n | 70n)).toBe(7000);
  expect(() => finalizedTarget(buy, 70n)).toThrow();
  expect(() => finalizedTarget(buy, 256n | 101n)).toThrow();
  const sell = packFeatureRecord({ ...fields, isBuy: false }) | (1n << 131n) | (80n << 123n);
  expect(finalizedTarget(sell)).toBe(8000);
  expect(() => decodeRecord(buy | (1n << 200n))).toThrow();
  expect(squaredError(zero(), [{ inputs: decodeRecord(buy).inputs, target: 0 }])).toBe(25000000n);
});
