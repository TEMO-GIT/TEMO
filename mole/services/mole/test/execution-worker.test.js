// DEV-ONLY: worker ordering and role validation, without signing or network access.
import { test, expect } from 'bun:test';
import { keccak256 } from 'viem';
import { executionTick } from '../src/execution-worker.js';
import { contractRevision } from '../src/contract-model.js';

const addr = n => `0x${n.toString(16).padStart(40, '0')}`;
function fixture() {
  const scope = { chainId: 1, signer: addr(1), hook: addr(2), model: addr(3),
    verificationMode: 'offchain-phala', contractRevision };
  let state = { scope, actions: {}, publications: {} }, resumes = 0;
  const store = { load: () => structuredClone(state), save: next => { state = structuredClone(next); } };
  const client = {
    getChainId: async () => 1, getBlock: async () => ({ number: 10n, timestamp: 100000n }),
    getCode: async () => '0x00',
    readContract: async ({ functionName }) => functionName === 'model' ? scope.model : functionName === 'hook' ? scope.hook
      : functionName === 'mole' ? scope.signer : (() => { throw Error('Unexpected contract getter'); })(),
    getLogs: async () => { throw new Error('Must resume the transaction first'); },
  };
  const executor = { resume: async () => { resumes++; return { status: 'submitted' }; } };
  return { client, store, executor, codeHashes: Object.fromEntries(['hook', 'model'].map(k => [k, keccak256('0x00')])),
    deploymentBlock: 1n, resumes: () => resumes };
}
test('worker reconciles its journal before reading new trades or starting new work', async () => {
  const f = fixture();
  expect((await executionTick(f)).status).toBe('transaction_submitted');
  expect(f.resumes()).toBe(1);
});
test('wrong immutable mole or hook-model bindings prevent any transaction resume', async () => {
  for (const field of ['mole', 'hook', 'model']) {
    const f = fixture(), read = f.client.readContract;
    f.client.readContract = request => request.functionName === field
      ? Promise.resolve(addr(99)) : read(request);
    await expect(executionTick(f)).rejects.toThrow('role binding mismatch');
    expect(f.resumes()).toBe(0);
  }
});
test('legacy scopes and stale revisions fail closed without rewriting their journal', async () => {
  for (const patch of [{proof:addr(4)}, {verifier:addr(4)}, {mrTdHash:keccak256('0x12')},
    {rtmrHash:keccak256('0x12')}, {verificationMode:undefined}, {contractRevision:'old'}]) {
    const f = fixture(), state = f.store.load();
    Object.assign(state.scope, patch); f.store.save(state);
    await expect(executionTick(f)).rejects.toThrow('Current off-chain deployment scope required');
    expect(f.resumes()).toBe(0);
    expect(f.store.load()).toEqual(state);
  }
});
test('changed runtime code prevents execution', async () => {
  const f = fixture(); f.codeHashes.hook = keccak256('0x01');
  await expect(executionTick(f)).rejects.toThrow('bytecode mismatch');
  expect(f.resumes()).toBe(0);
});
test('legacy proof entries cannot be resumed even with an updated scope', async () => {
  const f = fixture(), state = f.store.load();
  state.actions.old = {action:{kind:'prove'},status:'submitted'}; f.store.save(state);
  await expect(executionTick(f)).rejects.toThrow('Legacy proof journal');
  expect(f.resumes()).toBe(0); expect(f.store.load()).toEqual(state);
});
