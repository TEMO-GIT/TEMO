// DEV-ONLY: public response privacy and halted-worker status.
import { test, expect } from 'bun:test';
import { executionStatus } from '../src/execution-status.js';

test('public execution status reports queue progress and never serializes private state',()=>{
  const secret='private-test-sentinel';
  const state={actions:Object.fromEntries(['prepared','signed','submitted','broadcast_unknown','mined','mined_reverted','confirmed','reverted']
    .map((status,i)=>[i,{status,raw:secret,action:{answers:[secret]}}])),
    seasons:{openings:{owner:{salt:secret}},invalid:{owner:secret}},dataset:{block:{number:'100'},rows:[secret]}};
  const report=executionStatus(state,{status:'transaction_submitted',walletAddress:'development-wallet'});
  expect(report.queue).toEqual({awaitingInclusion:4,awaitingFinality:2,confirmed:1,reverted:1});
  expect(report.tradeCheckpoint).toBe('100');expect(report.invalidCapsules).toBe(1);
  expect(JSON.stringify(report)).not.toContain(secret);
  state.halted=secret;
  const halted=executionStatus(state,{status:'transaction_submitted'});
  expect(halted.transactionsEnabled).toBe(false);expect(halted.status).toBe('halted');
  expect(JSON.stringify(halted)).not.toContain(secret);
  delete state.halted;
  expect(executionStatus(state,{status:'stopping',stopping:true}).transactionsEnabled).toBe(false);
});
