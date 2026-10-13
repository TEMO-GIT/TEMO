import { decodeRecord, encodeWeights, squaredError } from './contract-model.js';

export const trainingPolicy = Object.freeze({ version: 'temo-training-v1', source: 'temo_only',
  history: 'all_finalized', validationFraction: 0.2, minGroupsPerPartition: 16,
  minImprovementPercent: 3, scheduleSeconds: 86400, epochs: 72, learningRate: 0.01,
  split: 'latest_position_groups_with_temporal_and_origin_purge',
  optimizer: 'full_batch_adam_float_surrogate_integer_candidate_validation' });

export function partitionExamples(dataset) {
  const resolved = new Map(dataset.examples.map(e => [e.index, e])), groups = new Map(), last = new Map();
  for (const row of dataset.rows) {
    const decoded = decodeRecord(row.record);
    if (decoded.fields.isBuy) last.set(row.origin, `position:${decoded.positionId}`);
    // Conservative grouping: sells stay with the last observed buy until a new position appears.
    // This may join post-close sells, but never splits buys and related sales across partitions.
    const id = last.get(row.origin) ?? `unpositioned:${row.origin}`;
    if (!groups.has(id)) groups.set(id, { id, origin: row.origin, examples: [], first: BigInt(row.index), last: 0n, pending: false });
    const group = groups.get(id);
    group.last = BigInt(row.index);
    const example = resolved.get(row.index);
    if (example) group.examples.push(example);
    else group.pending = true;
  }
  const eligible = [...groups.values()].filter(g => !g.pending && g.examples.length)
    .sort((a, b) => a.last < b.last ? -1 : 1);
  const n = Math.ceil(eligible.length * trainingPolicy.validationFraction);
  const validation = n ? eligible.slice(-n) : [];
  const origins = new Set(validation.map(g => g.origin));
  const cutoff = validation.reduce((min, g) => g.first < min ? g.first : min, 1n << 256n);
  const training = eligible.slice(0, eligible.length - n).filter(g => g.last < cutoff && !origins.has(g.origin));
  return { training: training.flatMap(g => g.examples), validation: validation.flatMap(g => g.examples),
    trainingGroups: training.length, validationGroups: validation.length,
    excludedGroups: groups.size - training.length - validation.length,
    sufficient: training.length >= trainingPolicy.minGroupsPerPartition && validation.length >= trainingPolicy.minGroupsPerPartition };
}

// Float gradients are only a search aid; all acceptance metrics use the exact integer model.
export async function trainCandidate({ dataset, currentWeights, signal }) {
  const split = partitionExamples(dataset);
  return trainPartition({ split, currentWeights, signal });
}

export async function trainPartition({ split, currentWeights, signal, policy = trainingPolicy }) {
  encodeWeights(currentWeights);
  const summary = { trainingGroups: split.trainingGroups, validationGroups: split.validationGroups,
    excludedGroups: split.excludedGroups, trainingExamples: split.training.length, validationExamples: split.validation.length };
  if (!split.sufficient) return { status: 'insufficient_data', policy, ...summary };
  const w = currentWeights.map(x => x / 256), m = Array(177).fill(0), v = Array(177).fill(0);
  if (w.slice(0, 176).every(x => x === 0)) {
    // Deterministic symmetry breaking for a zero model; no replacement of a nonzero initial model.
    let seed = 0x54454d4f;
    for (let i = 0; i < 176; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; w[i] = (seed / 2 ** 32 - 0.5) / 8; }
  }
  let best = [...currentWeights], bestTrain = squaredError(best, split.training);
  const quantize = () => w.map(x => Math.max(-32768, Math.min(32767, Math.round(x * 256))));
  for (let epoch = 1; epoch <= trainingPolicy.epochs; epoch++) {
    signal?.throwIfAborted();
    const gradient = Array(177).fill(0);
    for (const example of split.training) {
      const x = example.inputs.map(value => value / 256), hidden = Array(16).fill(0);
      for (let j = 0; j < 16; j++) {
        let z = w[144 + j];
        for (let i = 0; i < 9; i++) z += w[j * 9 + i] * x[i];
        hidden[j] = Math.max(0, z);
      }
      let logit = w[176];
      for (let j = 0; j < 16; j++) logit += w[160 + j] * hidden[j];
      const p = Math.max(0, Math.min(1, 0.5 + logit / 8));
      const d = logit <= -4 || logit >= 4 ? 0 : 2 * (p - example.target / 10000) / 8;
      gradient[176] += d;
      for (let j = 0; j < 16; j++) {
        gradient[160 + j] += d * hidden[j];
        if (hidden[j] <= 0) continue;
        const dh = d * w[160 + j]; gradient[144 + j] += dh;
        for (let i = 0; i < 9; i++) gradient[j * 9 + i] += dh * x[i];
      }
    }
    for (let i = 0; i < 177; i++) {
      const g = gradient[i] / split.training.length;
      m[i] = 0.9 * m[i] + 0.1 * g; v[i] = 0.999 * v[i] + 0.001 * g * g;
      w[i] -= trainingPolicy.learningRate * (m[i] / (1 - 0.9 ** epoch)) / (Math.sqrt(v[i] / (1 - 0.999 ** epoch)) + 1e-8);
      w[i] = Math.max(-128, Math.min(32767 / 256, w[i]));
    }
    if (epoch % 8 === 0 || epoch === trainingPolicy.epochs) {
      const candidate = quantize(), error = squaredError(candidate, split.training);
      if (error < bestTrain) { best = candidate; bestTrain = error; }
    }
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  const oldError = squaredError(currentWeights, split.validation), newError = squaredError(best, split.validation);
  const improved = newError < oldError && newError * 100n <= oldError * 97n;
  return { status: improved ? 'candidate' : 'no_improvement', policy, ...summary,
    oldValidationSse: oldError.toString(), newValidationSse: newError.toString(),
    trainingSse: bestTrain.toString(), weights: best, weightBytes: encodeWeights(best),
    contractAdoption: 'pending_on_chain_judgment', transactionsEnabled: false };
}
