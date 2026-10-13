// DEV-ONLY: isolated HTTP service and injected dependencies; no chain or Phala access.
import { test, expect } from 'bun:test';
import { startExecutionService } from '../cloud/execution-service.js';
import { validateExecutionConfig } from '../cloud/execution-config.js';
import { executionProfile } from '../cloud/profiles.js';
import { contractRevision } from '../src/contract-model.js';

function fixture(enabled = false) {
  const profile = executionProfile('production');
  const config = { verificationMode: 'offchain-phala', contractRevision, chainId: 1, deploymentBlock: '1',
    storePath: '/tmp/test.db', transactionsEnabled: enabled,
    gasPolicy: { maxGas: '4000000', maxFeePerGas: '10', maxPriorityFeePerGas: '1', maxTransactionWei: '40000000', dailyReserveWei: '80000000' },
    ...Object.fromEntries(['hook', 'model', 'burrow', 'token', 'graphFactory'].map((k,i)=>[k,`0x${String(i+1).repeat(40)}`])),
    codeHashes: Object.fromEntries(['hook','model','burrow','token'].map(k=>[k,`0x${'a'.repeat(64)}`])) };
  const info = { app_id: profile.appId, compose_hash: 'b'.repeat(64) };
  const calls = { keys: 0, opened: 0, executors: 0, ticks: 0, closed: 0 };
  const state = { actions: {}, scope: {} };
  const deps = { config, profile, dstack: { info: async()=>info }, client: {}, port: 0, hostname: '127.0.0.1', log: ()=>{},
    loadSigner: async(_d,path,options)=>{ calls.keys++;calls.path=path;calls.options=options;return {address:profile.walletAddress}; },
    openStore: async()=>{calls.opened++;return {load:()=>state,close:async()=>{calls.closed++;}};},
    createExecutor: ()=>{calls.executors++;return {};}, verifyBindings:async()=>{},verifyModel:async()=>{},
    runTick:async()=>{calls.ticks++;return {status:'idle'};} };
  return { deps, calls, info, state };
}

test('execution configuration rejects implicit activation, legacy fields and incomplete spending bounds',()=>{
  const {deps:{config}}=fixture();
  for(const change of [{transactionsEnabled:undefined},{transactionsEnabled:'true'},{proof:null},
    {deploymentBlock:null},{chainId:31337},{model:'0x'},{storePath:'relative.db'},
    {transactionsEnabled:true,gasPolicy:{}},{codeHashes:{}}]) {
    expect(()=>validateExecutionConfig({...config,...change})).toThrow();
  }
  expect(validateExecutionConfig({...config,gasPolicy:{}}).transactionsEnabled).toBe(false);
});

test('production profile preserves the reserved app, wallet and key derivation',()=>{
  const prod=executionProfile('production'),dev=executionProfile('development');
  expect(prod).toMatchObject({mode:'phala-execution-production',appId:'8c8611b298e5d97b18fd479d03ae4696f3e951ce',
    walletAddress:'0x43a02861eE0d4c6D1881c0a24937b6Bf95dA9917',keyPath:'temo/production/ethereum-wallet/v1'});
  expect(prod.keyPath).not.toBe(dev.keyPath);expect(prod.appId).not.toBe(dev.appId);
});

test('wrong Phala app is rejected before obtaining a key; wrong wallet before opening a journal',async()=>{
  const f=fixture();f.info.app_id=executionProfile('development').appId;
  await expect(startExecutionService(f.deps)).rejects.toThrow('app mismatch');expect(f.calls.keys).toBe(0);
  f.info.app_id=f.deps.profile.appId;
  f.deps.loadSigner=async()=>({address:executionProfile('development').walletAddress});
  await expect(startExecutionService(f.deps)).rejects.toThrow('wallet mismatch');expect(f.calls.opened).toBe(0);
});

test('observation mode cannot create an executor or resume saved actions and exposes no private journal data',async()=>{
  const f=fixture(); f.state.actions.saved={status:'submitted',raw:'private-signed-bytes',action:{answers:['private-answer']}};
  const service=await startExecutionService(f.deps);
  try {
    const get=(p,options)=>fetch(new URL(p,service.url),options);
    expect((await get('/health/ready')).status).toBe(503);
    expect((await service.tick()).status).toBe('observing');
    expect(f.calls.options.transactions).toBe(false);expect(f.calls.executors).toBe(0);expect(f.calls.ticks).toBe(0);
    const text=await (await get('/v1/status')).text();
    expect(text).not.toContain('private-');expect(JSON.parse(text)).toMatchObject({mode:'phala-execution-production',transactionsEnabled:false,observationOnly:true});
    expect((await get('/health/ready')).status).toBe(200);
    expect((await get('/sign',{method:'POST'})).status).toBe(404);
    expect((await get('/v1/status',{method:'POST'})).status).toBe(405);
    f.state.halted='private-halt-reason';expect((await get('/health/ready')).status).toBe(503);
  } finally {await service.stop();}
  expect(f.calls.closed).toBe(1);
});

test('active mode gates every tick on identity and graph checks, and reports failure without leaking details',async()=>{
  const f=fixture(true);const service=await startExecutionService(f.deps);
  try {
    expect(service.snapshot().transactionsEnabled).toBe(false);
    await service.tick();expect(f.calls.ticks).toBe(1);expect(f.calls.options.transactions).toBe(true);
    expect(service.snapshot().transactionsEnabled).toBe(true);
    f.info.compose_hash='c'.repeat(64);
    await expect(service.tick()).rejects.toThrow('identity changed');
    expect(f.calls.ticks).toBe(1);expect(service.snapshot().transactionsEnabled).toBe(false);
  } finally {await service.stop();}
  const g=fixture(true);g.deps.verifyBindings=async()=>{throw Error('private-RPC-url');};
  const second=await startExecutionService(g.deps);
  try {
    await expect(second.tick()).rejects.toThrow();expect(g.calls.ticks).toBe(0);
    expect(JSON.stringify(second.snapshot())).not.toContain('private-RPC-url');
  } finally {await second.stop();}
});

test('ticks cannot overlap; shutdown waits for the in-flight journal user before closing storage',async()=>{
  const f=fixture(true);let release,entered;
  const started=new Promise(resolve=>{entered=resolve;});
  f.deps.runTick=async()=>{entered();await new Promise(resolve=>{release=resolve;});return {status:'idle'};};
  const service=await startExecutionService(f.deps);
  const tick=service.tick();await started;
  await expect(service.tick()).rejects.toThrow('already active');
  const stopping=service.stop();expect(f.calls.closed).toBe(0);
  await expect(service.tick()).rejects.toThrow('stopping');expect(service.snapshot().transactionsEnabled).toBe(false);
  release();await tick;await stopping;expect(f.calls.closed).toBe(1);
});

test('startup failure after opening the journal releases its lease',async()=>{
  const f=fixture(true);f.deps.createExecutor=()=>{throw Error('executor setup failed');};
  await expect(startExecutionService(f.deps)).rejects.toThrow();expect(f.calls.closed).toBe(1);
});

test('a transient failed tick does not close storage or stop subsequent work',async()=>{
  const f=fixture(true);let fail=true;
  f.deps.runTick=async()=>{if(fail)throw Error('temporary RPC failure');return {status:'settlement_funding_wait'};};
  const service=await startExecutionService(f.deps);
  try {
    await expect(service.tick()).rejects.toThrow('temporary');expect(f.calls.closed).toBe(0);
    expect(service.snapshot().status).toBe('error');fail=false;
    expect((await service.tick()).status).toBe('settlement_funding_wait');expect(f.calls.closed).toBe(0);
    expect(service.snapshot().status).toBe('settlement_funding_wait');
  } finally {await service.stop();}
});
