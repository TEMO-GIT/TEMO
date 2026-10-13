import { verifyDeployment, advancePublication } from './publication.js';
import { dueSettlements, isSeasonAction } from './actions.js';
import { advanceSeasonKeeper } from './season-keeper.js';
import { readLiveDataset } from './live-data.js';
import { rehearseModelCycle } from './model-cycle.js';
import { modelAbi } from './contract-abi.js';
import { transactionIncluded } from './transaction-status.js';

// One serialized tick. The owning process retains the journal lock for its entire lifetime.
export async function executionTick({ client, executor, store, codeHashes, deploymentBlock, signal, getBeacon }) {
  let state = store.load();
  if (state.halted) return { status: 'halted', reason: state.halted };
  await verifyDeployment({ client, scope: state.scope, codeHashes });
  if (state.proofAction || Object.values(state.actions).some(entry => entry.action.kind === 'prove')) {
    throw new Error('Legacy proof journal requires explicit migration');
  }
  const resumed = await executor.resume();
  const failed = Object.values(store.load().actions).find(a => a.status === 'reverted' &&
    !isSeasonAction(a.action) && a.action.kind !== 'judge');
  if (failed || (resumed?.status === 'reverted' && resumed.action.kind === 'judge' && !store.load().candidate)) {
    state = store.load(); state.halted = 'Journaled transaction reverted'; store.save(state);
    return { status: 'halted', reason: state.halted };
  }
  if (resumed && resumed.status !== 'reverted' && !transactionIncluded(resumed)) return { status: `transaction_${resumed.status}` };
  state = store.load();
  // Once a model candidate is committed, judge it before spending nonces on a reveal queue.
  // The beacon normally arrives after a minute; judgment must not expire behind a busy season.
  if (state.candidate && state.scope.burrow) {
    const pending = await client.readContract({address:state.scope.model,abi:modelAbi,functionName:'pending'});
    if (BigInt(pending[0]) !== 0n) {
      const result = await advancePublication({client,executor,store,codeHashes,candidate:state.candidate,getBeacon,signal});
      state = store.load();state.lastPublication = result;
      if (['adopted','rejected','stale'].includes(result.status)) delete state.candidate;
      if (result.status === 'reverted') state.halted = 'Publication transaction reverted';
      store.save(state);return result;
    }
  }
  if (state.scope.burrow) {
    const season = await advanceSeasonKeeper({client,executor,store,deploymentBlock,signal,urgentOnly:Boolean(state.candidate)});
    if (season.status !== 'seasons_idle') return season;
    state = store.load();
  }
  if (state.candidate) {
    const result = await advancePublication({ client, executor, store, codeHashes, candidate: state.candidate, getBeacon, signal });
    state = store.load(); state.lastPublication = result;
    if (['adopted', 'rejected', 'stale'].includes(result.status)) delete state.candidate;
    if (result.status === 'reverted') state.halted = 'Publication transaction reverted';
    store.save(state); return result;
  }
  const hook = state.scope.hook;
  const dataset = await readLiveDataset({ client, hook, deploymentBlock, previous: state.dataset, signal });
  state = store.load(); state.dataset = dataset; store.save(state);
  const settlement = await dueSettlements({ client, hook, origins: dataset.pendingOrigins });
  if (settlement) {
    const result = await executor.advance(settlement.id, settlement);
    if (result.status === 'reverted') {
      state = store.load(); state.halted = 'Settlement transaction reverted'; store.save(state);
    }
    return { status: `settlement_${result.status}` };
  }
  const cycle = await rehearseModelCycle({ client, hook, deploymentBlock, previousDataset: dataset,
    previousAttemptAt: state.attemptAt ?? null, signal });
  state = store.load(); state.dataset = cycle.dataset; state.attemptAt = cycle.attemptAt;
  state.lastTraining = { status: cycle.status, block: cycle.dataset.block, attemptAt: cycle.attemptAt };
  if (cycle.status === 'candidate') state.candidate = cycle;
  store.save(state);
  return { status: cycle.status === 'candidate' ? 'candidate_saved' : cycle.status };
}
