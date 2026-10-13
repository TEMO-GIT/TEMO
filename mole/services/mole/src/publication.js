import { isAddress, keccak256 } from 'viem';
import { actionId } from './actions.js';
import { modelAbi, hookAbi } from './contract-abi.js';
import { decodeWeights, contractRevision } from './contract-model.js';
import { fetchBeacon, roundTime } from './drand.js';
import { transactionIncluded } from './transaction-status.js';

export async function verifyDeployment({ client, scope, codeHashes }) {
  if (scope.verificationMode !== 'offchain-phala' || scope.contractRevision !== contractRevision ||
      ['verifier', 'mrTdHash', 'rtmrHash', 'proof'].some(key => scope[key] !== undefined)) {
    throw new Error('Current off-chain deployment scope required; legacy journals need explicit migration');
  }
  if (!isAddress(scope.signer) || BigInt(scope.signer) === 0n) throw new Error('Mole address required');
  if (await client.getChainId() !== scope.chainId) throw new Error('Deployment chain mismatch');
  const head = await client.getBlock({ blockTag: 'latest' });
  for (const name of ['hook', 'model']) {
    if (!isAddress(scope[name]) || !/^0x[0-9a-f]{64}$/i.test(codeHashes?.[name] ?? '')) throw new Error('Pinned deployment code hashes required');
    const code = await client.getCode({ address: scope[name], blockNumber: head.number });
    if (!code || code === '0x' || keccak256(code) !== codeHashes[name].toLowerCase()) throw new Error('Deployment bytecode mismatch');
  }
  const read = (address, abi, functionName) => client.readContract({ address, abi, functionName, blockNumber: head.number });
  const [hookModel, modelHook, mole] = await Promise.all([
    read(scope.hook, hookAbi, 'model'), read(scope.model, modelAbi, 'hook'),
    read(scope.model, modelAbi, 'mole'),
  ]);
  if ([hookModel, modelHook, mole].some((value, i) => value.toLowerCase() !==
    [scope.model, scope.hook, scope.signer][i].toLowerCase())) throw new Error('Deployment role binding mismatch');
  return { head };
}

export async function advancePublication({ client, executor, store, codeHashes, candidate, getBeacon = fetchBeacon, signal }) {
  const scope = store.load().scope;
  const { head } = await verifyDeployment({ client, scope, codeHashes });
  if (candidate.status !== 'candidate' || candidate.training?.status !== 'candidate' ||
      candidate.dataset?.source?.hook !== scope.hook.toLowerCase() || candidate.dataset.source.chainId !== scope.chainId ||
      candidate.model.address.toLowerCase() !== scope.model.toLowerCase()) throw new Error('Invalid publication candidate');
  const training = candidate.training;
  decodeWeights(training.weightBytes);
  const oldSse = BigInt(training.oldValidationSse), newSse = BigInt(training.newValidationSse);
  if (newSse < 0n || newSse >= oldSse || newSse * 100n > oldSse * 97n) throw new Error('Candidate failed local improvement gate');
  const id = actionId({ chain: scope.chainId, model: scope.model, snapshot: candidate.dataset.block.hash,
    baseline: candidate.model.weightsAddress, weights: training.weightBytes });
  const save = publication => { const state = store.load(); state.publications[id] = publication; store.save(state); };
  let publication = store.load().publications[id] ?? { id, status: 'new' };
  if (['adopted', 'rejected', 'stale', 'reverted'].includes(publication.status)) return publication;
  const resumed = await executor.resume();
  if (resumed?.status === 'reverted' && resumed.action.kind !== 'judge') {
    publication.status = 'reverted'; save(publication); return publication;
  }
  if (resumed && resumed.status !== 'reverted' && !transactionIncluded(resumed)) return { ...publication, status: `transaction_${resumed.status}` };
  const read = functionName => client.readContract({ address: scope.model, abi: modelAbi, functionName, blockNumber: head.number });
  const [current, pending, lastCommit] = await Promise.all([read('weights'), read('pending'), read('lastCommitAt')]);
  const commitId = actionId({ id, step: 'commit' });
  const committed = store.load().actions[commitId];
  if (!committed) {
    if (current.toLowerCase() !== candidate.model.weightsAddress.toLowerCase()) {
      publication.status = 'stale'; save(publication); return publication;
    }
    if (BigInt(pending[0]) !== 0n) return { ...publication, status: 'other_pending' };
    if (head.timestamp < BigInt(lastCommit) + 72000n) return { ...publication, status: 'commit_cooldown' };
    const baseline = await client.getCode({ address: current, blockNumber: head.number });
    if (baseline?.toLowerCase() !== candidate.model.weightBytes.toLowerCase()) throw new Error('Baseline model bytes changed');
  }
  const deployed = await executor.advance(actionId({ id, step: 'weights' }), { kind: 'weights', bytes: training.weightBytes });
  if (deployed.status === 'reverted') { publication.status = 'reverted'; save(publication); return publication; }
  if (!transactionIncluded(deployed)) return { ...publication, status: `weights_${deployed.status}` };
  publication.weightsAddress = deployed.receipt.contractAddress;
  const actual = await client.getCode({ address: publication.weightsAddress, blockNumber: BigInt(deployed.receipt.blockNumber) });
  if (actual?.toLowerCase() !== training.weightBytes.toLowerCase()) throw new Error('Deployed weight bytes mismatch');
  publication.status = deployed.status === 'confirmed' ? 'weights_confirmed' : 'weights_mined'; save(publication);
  const commit = await executor.advance(commitId, { kind: 'commit', weights: publication.weightsAddress });
  if (commit.status === 'reverted') { publication.status = 'reverted'; save(publication); return publication; }
  if (!transactionIncluded(commit)) return { ...publication, status: `commit_${commit.status}` };
  if (BigInt(pending[0]) === 0n) {
    const logs = await client.getLogs({ address: scope.model,
      event: modelAbi.find(e => e.name === 'WeightsJudged'), args: { weights: publication.weightsAddress },
      fromBlock: BigInt(commit.receipt.blockNumber), toBlock: head.number, strict: true });
    const finalized = await client.getBlock({ blockTag: 'finalized' });
    const result = logs.filter(log => !log.removed && log.blockNumber <= finalized.number &&
      log.address.toLowerCase() === scope.model.toLowerCase() &&
      log.args.weights.toLowerCase() === publication.weightsAddress.toLowerCase()).at(-1);
    if (!result) return { ...publication, status: 'judgment_confirmation_wait' };
    const anchor = await client.getBlock({ blockNumber: result.blockNumber });
    if (anchor.hash !== result.blockHash) throw new Error('Judgment log is not canonical');
    if (result.args.adopted && (await client.readContract({ address: scope.model, abi: modelAbi,
      functionName: 'weights', blockNumber: result.blockNumber })).toLowerCase() !== publication.weightsAddress.toLowerCase()) {
      throw new Error('Judgment event and active weights differ');
    }
    publication = { ...publication, status: result.args.adopted ? 'adopted' : 'rejected',
      judgment: { transactionHash: result.transactionHash, blockNumber: result.blockNumber.toString(),
        sseOld: result.args.sseOld.toString(), sseNew: result.args.sseNew.toString(), samples: result.args.samples.toString() } };
    save(publication); return publication;
  }
  if (pending[0].toLowerCase() !== publication.weightsAddress.toLowerCase()) return { ...publication, status: 'other_pending' };
  if (head.timestamp < roundTime(pending[2])) return { ...publication, status: 'beacon_wait' };
  const judgeId = actionId({ id, step: 'judge', round: pending[2].toString() });
  let action = store.load().actions[judgeId]?.action;
  if (!action) {
    const signature = head.timestamp > BigInt(pending[1]) + 86400n ? '0x' : await getBeacon(pending[2], { signal });
    action = { kind: 'judge', signature };
  }
  const judged = await executor.advance(judgeId, action);
  if (judged.status === 'reverted') { publication.status = 'reverted'; save(publication); return publication; }
  return { ...publication, status: `judge_${judged.status}` };
}
