// Live integration baseline; historical dataset revisions remain in their evidence manifests.
import { normalizeFeatureFields, unpackFeatureRecord, unsigned } from '../../../scripts/data/trade-features.js';

export const contractRevision = 'a3ca5802ea7dda21823471349269bd328e75eb3a';
export const weightCount = 177;

export function decodeWeights(code) {
  if (typeof code !== 'string' || !/^0x[0-9a-fA-F]{708}$/.test(code)) throw new Error('Expected 354 weight bytes');
  return Array.from({ length: weightCount }, (_, i) => {
    const word = parseInt(code.slice(2 + i * 4, 6 + i * 4), 16);
    return word >= 32768 ? word - 65536 : word;
  });
}

export function encodeWeights(weights) {
  validateWeights(weights);
  return `0x${weights.map(w => (w & 65535).toString(16).padStart(4, '0')).join('')}`;
}

function validateWeights(weights) {
  if (!Array.isArray(weights) || weights.length !== weightCount ||
      weights.some(w => !Number.isInteger(w) || w < -32768 || w > 32767)) throw new Error('Invalid int16 model weights');
}

export function decodeRecord(record) {
  const word = unsigned(record);
  if (word >> 164n) throw new Error('Unsupported record layout');
  const fields = unpackFeatureRecord(word);
  const label = Number((word >> 123n) & 255n), labelFinal = Boolean((word >> 131n) & 1n);
  const positionId = Number((word >> 132n) & 0xffffffffn);
  if (label > 100 || (fields.isBuy ? labelFinal || positionId === 0 : !labelFinal || positionId !== 0)) {
    throw new Error('Invalid live record label fields');
  }
  return { fields, inputs: normalizeFeatureFields(fields), label, labelFinal, positionId };
}

// A closed position with label zero is encoded as 256, never as the open sentinel zero.
export function finalizedTarget(record, position = 0n) {
  const decoded = decodeRecord(record);
  if (decoded.labelFinal) return decoded.label * 100;
  const word = unsigned(position);
  if (word === 0n) return null;
  if (word >> 9n || !(word & 256n) || (word & 255n) > 100n) throw new Error('Invalid closed position');
  return Number(word & 255n) * 100;
}

export function scoreInputs(weights, inputs) {
  validateWeights(weights);
  if (!Array.isArray(inputs) || inputs.length !== 9 ||
      inputs.some(x => !Number.isInteger(x) || x < 0 || x > 255)) throw new Error('Invalid normalized inputs');
  let out = BigInt(weights[176]) * 256n;
  for (let j = 0; j < 16; j++) {
    let hidden = BigInt(weights[144 + j]) * 256n;
    for (let i = 0; i < 9; i++) hidden += BigInt(weights[j * 9 + i]) * BigInt(inputs[i]);
    if (hidden > 0n) out += BigInt(weights[160 + j]) * (hidden / 256n);
  }
  // BigInt division truncates toward zero, matching EVM signed division at both stages.
  const score = ((out / 256n + 1024n) * 10000n) / 2048n;
  return Number(score < 0n ? 0n : score > 10000n ? 10000n : score);
}

export function scoreRecord(weights, record) {
  return scoreInputs(weights, normalizeFeatureFields(unpackFeatureRecord(record)));
}

export function squaredError(weights, examples) {
  let sum = 0n;
  for (const { inputs, target } of examples) {
    if (!Number.isInteger(target) || target < 0 || target > 10000) throw new Error('Invalid training target');
    const difference = BigInt(scoreInputs(weights, inputs) - target);
    sum += difference * difference;
  }
  return sum;
}
