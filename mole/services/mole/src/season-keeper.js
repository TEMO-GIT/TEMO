import { burrowAbi, tokenSnapshotAbi } from './contract-abi.js';
import { actionId, isSeasonAction } from './actions.js';
import { readCapsuleEvents, capsuleKey } from './capsule-data.js';
import { decryptCapsule, inspectCapsule, capsuleCommit } from '../../../shared/capsule.js';
import { transactionFinal, transactionIncluded } from './transaction-status.js';

const SELF_REVEAL = 86400n, CLAIM_WINDOW = 30n * 86400n;
const initialize = state => state.seasons ??= { openings: {}, invalid: {}, retryAfter: {}, published: {}, failed: {} };
const idFor = (scope, action) => actionId({ chainId: scope.chainId, burrow: scope.burrow.toLowerCase(), action });

// One action at a time through the same durable signer journal as model updates.
// Call only after deployment verification and reconciliation of any pending transaction.
export async function advanceSeasonKeeper({ client, executor, store, deploymentBlock, signal,
  decrypt = decryptCapsule, urgentOnly = false }) {
  let state = store.load();
  const scope = state.scope;
  const snapshot = await readCapsuleEvents({ client, burrow: scope.burrow, deploymentBlock,
    previous: state.capsules, signal });
  state = store.load(); state.capsules = snapshot; initialize(state); store.save(state);
  const finalizedBlock = BigInt(snapshot.block.number), now = BigInt(snapshot.block.timestamp);
  const read = (functionName, args, blockNumber = finalizedBlock) => client.readContract({
    address: scope.burrow, abi: burrowAbi, functionName, args, blockNumber });

  // An action may already have finalized before the worker persisted its season bookkeeping.
  // Recover from the receipt; never publish a second event just because the process restarted.
  state.seasons.reconciled ??= {};
  for (const [id, entry] of Object.entries(state.actions)) {
    if (isSeasonAction(entry.action) && transactionFinal(entry) && !state.seasons.reconciled[id]) {
      const a = entry.action;
      if (entry.status === 'confirmed' && a.kind === 'publish') {
        for (const owner of a.owners) state.seasons.published[capsuleKey(a.season,owner)] = entry.hash;
      }
      if (entry.status === 'reverted') {
        // Permissionless resolve/reveal may race another caller. Reconcile on-chain first.
        const done = a.kind === 'resolve' ? (await read('seasonInfo',[a.season]))[1]
          : a.kind === 'reveal' ? (await read('capsuleOf',[a.season,a.owner]))[1]
          : a.kind === 'rollover' ? await read('seasonInfo',[a.season]).then(v=>v[10]===v[11]) : false;
        if (!done) state.seasons.failed[id] = { kind:a.kind,season:a.season,reason:'Transaction reverted; operator review required',hash:entry.hash };
      }
      state.seasons.reconciled[id] = entry.status;
    }
  }
  store.save(state);
  const pending = state.seasons.pending;
  if (pending) {
    const entry = state.actions[pending.id];
    if (entry && !transactionFinal(entry) && !transactionIncluded(entry)) {
      const result = await executor.advance(pending.id, pending.action);
      return { status: `season_${pending.action.kind}_${result.status}` };
    }
    // No journal entry means no signing occurred (for example a fee cap); replan from current state.
    delete state.seasons.pending; store.save(state);
  }

  const submit = async action => {
    const id = idFor(scope,action);
    if (store.load().seasons.failed[id]) return null;
    const prior = store.load().actions[id];
    if (transactionIncluded(prior)) return null;
    state = store.load(); state.seasons.pending = { id,action }; store.save(state);
    const result = await executor.advance(id,action);
    return { status:`season_${action.kind}_${result.status}` };
  };

  // Mined publications reserve their owners until finality; reorg recovery rechecks these entries.
  const publishing = new Set(Object.values(store.load().actions)
    .filter(a => a.action.kind === 'publish' && transactionIncluded(a))
    .flatMap(a => a.action.owners.map(owner => capsuleKey(a.action.season, owner))));
  const revealed = new Set(Object.values(state.actions)
    .filter(a => a.action.kind === 'reveal' && transactionIncluded(a))
    .map(a => capsuleKey(a.action.season, a.action.owner)));

  const seasons = [];
  for (let season = snapshot.currentSeason; season >= 1; season--) {
    const end = BigInt(await read('seasonEnd',[season]));
    if (end > now) continue;
    const info = await read('seasonInfo',[season]);
    seasons.push({ season,end,info });
  }
  // Current reveal windows take priority over old publication/rollover backlogs.
  seasons.sort((a,b)=>Number((now<=a.end+SELF_REVEAL?0:1)-(now<=b.end+SELF_REVEAL?0:1)) || b.season-a.season);
  let decryptions = 0;
  for (const {season,end,info} of seasons) {
    signal?.throwIfAborted();
    if (urgentOnly && now > end+SELF_REVEAL) continue;
    let answerBlock = finalizedBlock;
    if (!info[1]) {
      const latest = await client.getBlock({blockTag:'latest'});
      if (!(await read('seasonInfo',[season],latest.number))[1]) {
        const result = await submit({kind:'resolve',season});
        if (result) return result;
        continue;
      }
      answerBlock = latest.number;
    }
    const winning = (await read('winning',[season],answerBlock)).map(Number);
    const start = BigInt(await read('seasonStart',[season]));
    const publish = [];
    for (const row of snapshot.rows.filter(r=>r.season===season)) {
      signal?.throwIfAborted();
      const key = capsuleKey(season,row.owner);
      if (state.seasons.invalid[key] || state.seasons.published[key] || publishing.has(key)) continue;
      // The serialized worker reconciles these receipts before planning. Revisit openings when
      // publication becomes due; repeating reads for already included reveals adds no new work.
      if (now <= end+SELF_REVEAL && revealed.has(key)) continue;
      const capsule = await read('capsuleOf',[season,row.owner]);
      if (capsule[0].toLowerCase() !== row.commit) throw new Error('Capsule event commitment differs from chain state');
      let opening = state.seasons.openings[key];
      if (!opening) {
        if (decryptions >= 16 || BigInt(state.seasons.retryAfter[key] ?? '0') > now) continue;
        try { inspectCapsule(row.ciphertext,end); }
        catch {
          state.seasons.invalid[key] = 'Invalid or unsupported ciphertext envelope'; store.save(state); continue;
        }
        decryptions++;
        try { opening = await decrypt({...row,seasonEnd:end},{signal}); }
        catch {
          signal?.throwIfAborted();
          // Relay failures and invalid authenticated payloads do not stop other capsules.
          state.seasons.retryAfter[key] = (now+300n).toString(); store.save(state); continue;
        }
        if (capsuleCommit({...row,...opening}) !== row.commit) throw new Error('Decrypted capsule commitment mismatch');
        state.seasons.openings[key] = opening; delete state.seasons.retryAfter[key]; store.save(state);
      }
      if (capsuleCommit({...row,...opening}) !== row.commit) throw new Error('Saved capsule commitment mismatch');
      if (now <= end+SELF_REVEAL && !capsule[1] && opening.answers.some((v,i)=>v===winning[i])) {
        const balance = timestamp => client.readContract({address:scope.token,abi:tokenSnapshotAbi,
          functionName:'balanceAt',args:[row.owner,timestamp],blockNumber:finalizedBlock});
        const [atStart,atEnd] = await Promise.all([balance(start),balance(end)]);
        if (atStart > 0n && atEnd > 0n) {
          const latest = await client.getBlock({blockTag:'latest'});
          if (latest.timestamp <= end+SELF_REVEAL && !(await read('capsuleOf',[season,row.owner],latest.number))[1]) {
            const result = await submit({kind:'reveal',season,owner:row.owner,...opening});
            if (result) return result;
          }
        }
      }
      if (now > end+SELF_REVEAL && publish.length < 32) publish.push({owner:row.owner,answers:opening.answers});
    }
    if (!urgentOnly && publish.length) {
      const result = await submit({kind:'publish',season,owners:publish.map(p=>p.owner),answers:publish.map(p=>p.answers)});
      if (result) return result;
    }
    if (!urgentOnly && now > end+SELF_REVEAL+CLAIM_WINDOW && info[10] > info[11]) {
      const latest = await client.getBlock({blockTag:'latest'});
      const current = await read('seasonInfo',[season],latest.number);
      if (current[10] > current[11]) {
        const result = await submit({kind:'rollover',season});
        if (result) return result;
      }
    }
  }
  return { status:'seasons_idle', failedActions:Object.keys(store.load().seasons.failed).length };
}
