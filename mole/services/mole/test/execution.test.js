// DEV-ONLY: signed local transactions and temporary journals; no real RPC or funded account.
import { test, expect } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { keccak256 } from 'viem';
import { openExecutionStore } from '../src/execution-store.js';
import { createTransactionExecutor } from '../src/transaction-executor.js';
import { actionId, buildAction, dueSettlements } from '../src/actions.js';
import { verifyBeacon } from '../src/drand.js';
import { moleReportData, createContractQuote } from '../src/proof-binding.js';

const address = `0x${'12'.repeat(20)}`, hash = `0x${'34'.repeat(32)}`;
const policy = { maxGas: '1000000', maxFeePerGas: '20', maxPriorityFeePerGas: '2', maxTransactionWei: '20000000', dailyReserveWei: '40000000' };
async function fixture() {
  const root = await mkdtemp(`${tmpdir()}/temo-execution-`), signer = privateKeyToAccount(generatePrivateKey());
  const scope = { chainId: 31337, signer: signer.address, hook: address, model: address };
  let store = await openExecutionStore(`${root}/state.db`, scope);
  const state = { nonce: 0, receipt: null, sends: [], loseResponse: true, failReceipt: false };
  const client = {
    getChainId: async () => 31337,
    getBlock: async () => ({ number: 10n, timestamp: 200000n, hash }),
    getTransactionCount: async () => state.nonce,
    estimateFeesPerGas: async () => ({ maxFeePerGas: 10n, maxPriorityFeePerGas: 1n }),
    call: async () => ({}), estimateGas: async () => 100000n, getBalance: async () => 100000000n,
    getTransactionReceipt: async () => {
      if (state.failReceipt) throw new Error('provider offline');
      if (state.receipt) return state.receipt;
      throw Object.assign(new Error('missing'), { name: 'TransactionReceiptNotFoundError' });
    },
    sendRawTransaction: async ({ serializedTransaction: raw }) => {
      state.sends.push(raw);
      if (state.loseResponse) throw new Error('lost network response');
      return keccak256(raw);
    },
  };
  return { state, client, signer, scope, get store() { return store; },
    executor: () => createTransactionExecutor({ client, signer, store, policy }),
    async restart() { await store.close(); store = await openExecutionStore(`${root}/state.db`, scope); },
    async close() { await store.close(); await rm(root, { recursive: true, force: true }); } };
}
test('lost broadcast response and restart retain signed bytes and nonce; confirmation prevents resend', async () => {
  const f = await fixture();
  try {
    const action = { kind: 'settle', origins: [address] }, id = actionId(action);
    expect((await f.executor().advance(id, action)).status).toBe('broadcast_unknown');
    const saved = f.store.load().actions[id];
    expect(saved.raw).toBe(f.state.sends[0]);
    await f.restart(); f.state.loseResponse = false;
    expect((await f.executor().resume()).status).toBe('submitted');
    expect(f.state.sends[1]).toBe(f.state.sends[0]);
    f.state.receipt = { blockNumber: 10n, blockHash: hash, transactionHash: saved.hash, status: 'success', contractAddress: null, gasUsed: 50000n };
    expect((await f.executor().resume()).status).toBe('confirmed');
    expect((await f.executor().advance(id, action)).status).toBe('confirmed');
    expect(f.state.sends.length).toBe(2);
    await expect(f.executor().advance(id, { kind: 'judge', signature: '0x' })).rejects.toThrow('different payload');
  } finally { await f.close(); }
});
test('receipt RPC errors never become missing receipts, and unknown nonce consumption stops recovery', async () => {
  const f = await fixture();
  try {
    const action = { kind: 'settle', origins: [address] }, id = actionId(action);
    await f.executor().advance(id, action);
    f.state.failReceipt = true;
    await expect(f.executor().resume()).rejects.toThrow('provider offline');
    expect(f.state.sends.length).toBe(1);
    f.state.failReceipt = false; f.state.nonce = 1;
    await expect(f.executor().resume()).rejects.toThrow('Nonce consumed');
    expect(f.state.sends.length).toBe(1);
  } finally { await f.close(); }
});
test('fee caps wait before signing and active transactions block a second nonce', async () => {
  const f = await fixture();
  try {
    const action = { kind: 'settle', origins: [address] };
    const capped = createTransactionExecutor({ client: f.client, signer: f.signer, store: f.store, policy: { ...policy, maxFeePerGas: '5' } });
    expect((await capped.advance(actionId(action), action)).status).toBe('fee_cap_wait');
    expect(Object.keys(f.store.load().actions).length).toBe(0);
    await f.executor().advance(actionId(action), action);
    await expect(f.executor().advance(hash, { kind: 'judge', signature: '0x' })).rejects.toThrow('unresolved');
  } finally { await f.close(); }
});
test('settlement checks the last purchase timestamp and never uses first-buy age', async () => {
  const client = { getBlock: async () => ({ number: 1n, timestamp: 80000n }),
    readContract: async () => [0, 0, 0, 0, 1, 1, 10000, 0n, 0n, 0, 0] };
  expect(await dueSettlements({ client, hook: address, origins: [address] })).toBeNull();
  client.getBlock = async () => ({ number: 2n, timestamp: 82000n });
  expect((await dueSettlements({ client, hook: address, origins: [address] })).positions[0].lastBuyTs).toBe('10000');
  expect(() => buildAction({ kind: 'weights', bytes: `0xef${'00'.repeat(353)}` }, {})).toThrow('EIP-3541');
});
test('official quicknet signature verifies, wrong rounds and altered signatures fail', async () => {
  const beacon = await Bun.file(new URL('./fixtures/quicknet-1000.json', import.meta.url)).json();
  const signature = verifyBeacon(beacon, 1000n);
  expect(signature.length).toBe(258);
  expect(signature.slice(2, 130)).toBe('00000000000000000000000000000000144679b9a59af2ec876b1a6b1ad52ea9b1615fc3982b19576350f93447cb1125e342b73a8dd2bacbe47e4b6b63ed5e39');
  expect(() => verifyBeacon(beacon, 1001n)).toThrow();
  expect(() => verifyBeacon({ ...beacon, signature: '00'.repeat(48) }, 1000n)).toThrow();
});
test('contract quote binds the padded wallet address without a capsule key', async () => {
  const data = moleReportData(address);
  let supplied;
  const result = await createContractQuote({ getQuote: async bytes => { supplied = bytes; return { quote: 'abcd' }; } }, address);
  expect(result.reportData).toBe(data); expect(supplied.length).toBe(64);
  expect(data).toBe(`0x${'00'.repeat(12)}${address.slice(2)}${'00'.repeat(32)}`);
  expect(Buffer.from(supplied).toString('hex')).toBe(data.slice(2));
  expect(result.contractVerified).toBe(false);
  expect(moleReportData(`0x${'56'.repeat(20)}`)).not.toBe(data);
  expect(() => moleReportData(`0x${'00'.repeat(20)}`)).toThrow('Nonzero mole');
  expect(() => moleReportData('not-an-address')).toThrow('Nonzero mole');
  await expect(createContractQuote({ getQuote: async () => ({ quote: 'abc' }) }, address)).rejects.toThrow('quote encoding');
});

test('fully sold and already closed positions never produce settlement transactions', async () => {
  const client = { getBlock: async () => ({ number: 1n, timestamp: 200000n }),
    readContract: async () => [1, 150000, 2, 1, 0, 0, 0, 0n, 0n, 0, 0] };
  expect(await dueSettlements({ client, hook: address, origins: [address] })).toBeNull();
});

test('a shallow reorg reuses the signed transaction and stale receipts block sending', async () => {
  const f = await fixture();
  try {
    f.state.loseResponse = false;
    const action = { kind:'settle', origins:[address] }, id=actionId(action);
    await f.executor().advance(id,action);
    const saved=f.store.load().actions[id];
    f.state.receipt={blockNumber:10n,blockHash:hash,transactionHash:saved.hash,status:'success',contractAddress:null,gasUsed:50000n};
    f.client.getBlock=async({blockTag}={})=>({number:blockTag==='finalized'?9n:10n,timestamp:200000n,hash});
    expect((await f.executor().resume()).status).toBe('mined');
    f.client.getBlock=async()=>({number:10n,timestamp:200000n,hash:keccak256('0x5678')});
    await expect(f.executor().resume()).rejects.toThrow('canonical');
    expect(f.state.sends).toHaveLength(1);
    f.state.receipt=null;await f.restart();
    expect((await f.executor().resume()).status).toBe('submitted');
    expect(f.state.sends[1]).toBe(saved.raw);
  } finally {await f.close();}
});

test('failure to persist signed bytes prevents broadcast and restart resumes the prepared action', async () => {
  const f = await fixture();
  try {
    const action={kind:'settle',origins:[address]}, id=actionId(action);
    const save=f.store.save;
    f.store.save=state=>{
      if (Object.values(state.actions).some(a=>a.raw)) throw Error('Injected disk failure');
      return save(state);
    };
    await expect(f.executor().advance(id,action)).rejects.toThrow('disk failure');
    expect(f.state.sends).toHaveLength(0);expect(f.store.load().actions[id].status).toBe('prepared');
    await f.restart();f.state.loseResponse=false;
    expect((await f.executor().resume()).status).toBe('submitted');expect(f.state.sends).toHaveLength(1);
  } finally {await f.close();}
});

test('removed proof actions cannot reserve funds, sign or broadcast', async () => {
  const f = await fixture();
  try {
    const action = {kind:'prove',quote:'0xab',verifierFeeWei:'1'};
    await expect(f.executor().advance(actionId(action),action)).rejects.toThrow('Unsupported mole action');
    expect(Object.keys(f.store.load().actions)).toHaveLength(0);
    expect(f.state.sends).toHaveLength(0);
  } finally {await f.close();}
});

test('successful inclusion pipelines nonces; restart and reorg recover oldest bytes before later work', async () => {
  const f = await fixture();
  try {
    f.state.loseResponse = false;
    const receipts = new Map(); let finalized = 9n;
    f.client.getBlock = async ({blockTag, blockNumber} = {}) => ({number:blockNumber ?? (blockTag==='finalized'?finalized:10n),hash,timestamp:200000n});
    f.client.getTransactionReceipt = async ({hash}) => {
      if (receipts.has(hash)) return receipts.get(hash);
      throw Object.assign(Error('Missing'), {name:'TransactionReceiptNotFoundError'});
    };
    const first = {kind:'settle',origins:[address]}, second = {kind:'judge',signature:'0x'};
    const a = await f.executor().advance(actionId(first),first);
    const mine = entry => receipts.set(entry.hash,{blockNumber:10n,blockHash:hash,transactionHash:entry.hash,status:'success',contractAddress:null,gasUsed:50000n});
    mine(a); f.state.nonce = 1;
    const b = await f.executor().advance(actionId(second),second);
    expect(b.status).toBe('submitted'); expect(b.tx.nonce).toBe(1);
    expect(f.store.load().actions[actionId(first)].status).toBe('mined');
    mine(b); f.state.nonce = 2;
    await f.restart(); expect((await f.executor().resume()).status).toBe('mined');
    expect(f.state.sends).toHaveLength(2);
    receipts.clear(); f.state.nonce = 0;
    expect((await f.executor().resume()).status).toBe('submitted');
    expect(f.state.sends.at(-1)).toBe(a.raw);
    const third = {kind:'settle',origins:[f.signer.address]};
    await expect(f.executor().advance(actionId(third),third)).rejects.toThrow('unresolved');
    expect(Object.values(f.store.load().actions)).toHaveLength(2);
    mine(a); f.state.nonce = 1;
    expect((await f.executor().resume()).status).toBe('submitted');
    expect(f.state.sends.at(-1)).toBe(b.raw);
    mine(b); f.state.nonce = 2; finalized = 10n;
    await f.executor().resume();
    expect(Object.values(f.store.load().actions).every(a=>a.status==='confirmed')).toBe(true);
    expect((await f.executor().advance(actionId(third),third)).tx.nonce).toBe(2);
  } finally { await f.close(); }
});

test('a mined revert cannot release the next nonce before finality', async () => {
  const f = await fixture();
  try {
    const action={kind:'settle',origins:[address]}, entry=await f.executor().advance(actionId(action),action);
    f.state.receipt={blockNumber:10n,blockHash:hash,transactionHash:entry.hash,status:'reverted',gasUsed:50000n};
    f.client.getBlock=async({blockTag}={})=>({number:blockTag==='finalized'?9n:10n,hash,timestamp:200000n});
    expect((await f.executor().resume()).status).toBe('mined_reverted');
    const next={kind:'judge',signature:'0x'};
    await expect(f.executor().advance(actionId(next),next)).rejects.toThrow('unresolved');
    expect(f.state.sends).toHaveLength(1);
    f.client.getBlock=async()=>({number:10n,hash,timestamp:200000n});
    await expect(f.executor().advance(actionId(next),next)).rejects.toThrow('worker reconciliation');
    expect(f.state.sends).toHaveLength(1);
  } finally { await f.close(); }
});

test('zero balance waits without reserving a nonce; one-transaction funding below the daily limit resumes', async () => {
  const f=await fixture();
  try {
    const action={kind:'settle',origins:[address]},id=actionId(action);
    let balance=0n,calls=0;f.client.getBalance=async()=>balance;f.client.call=async()=>{calls++;return {};};
    const executor=createTransactionExecutor({client:f.client,signer:f.signer,store:f.store,
      policy:{...policy,dailyReserveWei:'100000000000000000'}});
    expect((await executor.advance(id,action)).status).toBe('funding_wait');
    expect(calls).toBe(0);expect(Object.keys(f.store.load().actions)).toHaveLength(0);
    balance=1199999n; // DEV-ONLY: one wei below the padded 120,000 gas * 10 wei fee cap.
    expect((await executor.advance(id,action)).status).toBe('funding_wait');
    expect(f.state.sends).toHaveLength(0);expect(Object.keys(f.store.load().actions)).toHaveLength(0);
    balance=1200000n;f.state.loseResponse=false;
    expect((await executor.advance(id,action)).status).toBe('submitted');
    expect(f.store.load().actions[id].tx.nonce).toBe(0);expect(f.state.sends).toHaveLength(1);
  } finally {await f.close();}
});

test('node funding failures during estimation wait and retry; unrelated provider failures remain errors',async()=>{
  const f=await fixture();
  try {
    const action={kind:'settle',origins:[address]},id=actionId(action);
    f.client.estimateGas=async()=>{throw {name:'EstimateGasExecutionError',cause:{name:'InsufficientFundsError'}};};
    expect((await f.executor().advance(id,action)).status).toBe('funding_wait');
    expect(Object.keys(f.store.load().actions)).toHaveLength(0);
    f.client.estimateGas=async()=>{throw Error('RPC unavailable');};
    await expect(f.executor().advance(id,action)).rejects.toThrow('RPC unavailable');
    f.client.estimateGas=async()=>{throw Object.assign(Error('Execution reverted'),{details:'gas required exceeds allowance: 999'});};
    await expect(f.executor().advance(id,action)).rejects.toThrow('Execution reverted');
    f.client.estimateGas=async()=>100000n;f.state.loseResponse=false;
    expect((await f.executor().advance(id,action)).status).toBe('submitted');
  } finally {await f.close();}
});

test('a reached daily cap still reconciles submitted transactions and allows new work next day',async()=>{
  const f=await fixture();
  try {
    let timestamp=200000n;f.client.getBlock=async()=>({number:10n,timestamp,hash});f.state.loseResponse=false;
    const executor=createTransactionExecutor({client:f.client,signer:f.signer,store:f.store,
      policy:{...policy,dailyReserveWei:'1200000'}}); // DEV-ONLY: one transaction per test day.
    const first={kind:'settle',origins:[address]},id=actionId(first);
    await executor.advance(id,first);const saved=f.store.load().actions[id];
    f.state.receipt={blockNumber:10n,blockHash:hash,transactionHash:saved.hash,status:'success',contractAddress:null,gasUsed:50000n};
    expect((await executor.resume()).status).toBe('confirmed');f.state.nonce=1;f.state.receipt=null;
    const second={kind:'judge',signature:'0x'};
    expect((await executor.advance(actionId(second),second)).status).toBe('daily_cap_wait');
    timestamp+=86400n;
    expect((await executor.advance(actionId(second),second)).status).toBe('submitted');
    expect(f.store.load().actions[actionId(second)].tx.nonce).toBe(1);
  } finally {await f.close();}
});

test('a transaction landing after midnight still consumes that day budget before new submissions',async()=>{
  const f=await fixture();
  try {
    let timestamp=200000n;f.client.getBlock=async()=>({number:10n,timestamp,hash});f.state.loseResponse=false;
    const executor=createTransactionExecutor({client:f.client,signer:f.signer,store:f.store,
      policy:{...policy,dailyReserveWei:'1200000'}}); // DEV-ONLY
    const first={kind:'settle',origins:[address]},id=actionId(first);
    await executor.advance(id,first);const saved=f.store.load().actions[id];
    timestamp+=86400n;
    f.state.receipt={blockNumber:10n,blockHash:hash,transactionHash:saved.hash,status:'success',contractAddress:null,gasUsed:50000n};
    expect((await executor.resume()).status).toBe('confirmed');f.state.nonce=1;f.state.receipt=null;
    const second={kind:'judge',signature:'0x'};
    expect((await executor.advance(actionId(second),second)).status).toBe('daily_cap_wait');
    expect(f.state.sends).toHaveLength(1);
  } finally {await f.close();}
});
