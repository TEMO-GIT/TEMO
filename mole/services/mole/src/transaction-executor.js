import { keccak256, parseTransaction, recoverTransactionAddress } from 'viem';
import { actionId, buildAction } from './actions.js';
import { transactionFinal as terminalEntry, transactionIncluded } from './transaction-status.js';

const terminal = state => ['confirmed', 'reverted'].includes(state);
const serialize = tx => Object.fromEntries(Object.entries(tx).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v]));
function insufficientFunds(error, balanceGas) {
  // Viem wraps node failures; only classify the explicit funding error, not arbitrary RPC failures.
  for (let depth = 0; error && depth < 8; depth++, error = error.cause) {
    if (error.name === 'InsufficientFundsError') return true;
    // Some nodes expose the balance-derived estimate ceiling as an out-of-gas allowance.
    // Only accept an exact match to the wallet's ceiling; unrelated execution reverts still fail.
    const allowance = /gas required exceeds allowance[: (]+([0-9]+)/i.exec(error.details ?? '');
    if (balanceGas !== undefined && allowance && BigInt(allowance[1]) === balanceGas) return true;
  }
  return false;
}
function hydrate(tx) {
  return { ...tx, gas: BigInt(tx.gas), value: BigInt(tx.value), maxFeePerGas: BigInt(tx.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas) };
}
export function validateGasPolicy(policy) {
  for (const name of ['maxGas', 'maxFeePerGas', 'maxPriorityFeePerGas', 'maxTransactionWei', 'dailyReserveWei']) {
    if (!/^[1-9][0-9]*$/.test(policy?.[name] ?? '')) throw new Error(`Explicit gas policy required: ${name}`);
  }
  if (BigInt(policy.maxPriorityFeePerGas) > BigInt(policy.maxFeePerGas)) throw new Error('Invalid priority fee cap');
}

export function createTransactionExecutor({ client, signer, store, policy }) {
  validateGasPolicy(policy);
  const scope = store.load().scope;
  if (signer.address.toLowerCase() !== scope.signer.toLowerCase()) throw new Error('Signer differs from execution store');
  let busy = false;
  const saveAction = (id, action) => { const state = store.load(); state.actions[id] = action; store.save(state); };
  async function run(id, action, reconciling = false) {
    if (store.load().halted) throw new Error('Execution store is halted; reconcile before submitting');
    if (!/^0x[0-9a-f]{64}$/.test(id)) throw new Error('Invalid action id');
    if (await client.getChainId() !== scope.chainId) throw new Error('Execution chain mismatch');
    const payload = buildAction(action, scope), digest = actionId(action);
    let entry = store.load().actions[id];
    if (entry && entry.digest !== digest) throw new Error('Action id reused with different payload');
    if (!reconciling) {
      const reconciled = await reconcile();
      if (reconciled?.status === 'reverted' && reconciled.digest !== digest) {
        throw new Error('Reverted transaction requires worker reconciliation');
      }
      entry = store.load().actions[id];
    }
    if (entry && terminal(entry.status)) return entry;
    if (!reconciling && Object.entries(store.load().actions).some(([key, value]) => key !== id &&
        !terminal(value.status) && !transactionIncluded(value))) {
      throw new Error('Another transaction is unresolved');
    }
    // Reconciliation already inspected/rebroadcast this entry; do not send it twice in one call.
    if (entry && !reconciling) return entry;
    if (!entry) {
      const block = await client.getBlock({ blockTag: 'latest' });
      const [nonce, pendingNonce] = await Promise.all([
        client.getTransactionCount({ address: signer.address, blockTag: 'latest' }),
        client.getTransactionCount({ address: signer.address, blockTag: 'pending' }),
      ]);
      if (nonce !== pendingNonce) throw new Error('Unjournaled pending wallet transaction');
      const allocated = Object.values(store.load().actions).map(a => a.tx.nonce);
      if (allocated.length && nonce !== allocated.reduce((max, n) => Math.max(max, n), -1) + 1) throw new Error('Wallet nonce differs from journal history');
      const fees = await client.estimateFeesPerGas();
      const maxFeePerGas = fees.maxFeePerGas, maxPriorityFeePerGas = fees.maxPriorityFeePerGas;
      if (typeof maxFeePerGas !== 'bigint' || typeof maxPriorityFeePerGas !== 'bigint' ||
          maxFeePerGas < 0n || maxPriorityFeePerGas < 0n || maxPriorityFeePerGas > maxFeePerGas) throw new Error('Invalid fee estimate');
      if (maxFeePerGas > BigInt(policy.maxFeePerGas) || maxPriorityFeePerGas > BigInt(policy.maxPriorityFeePerGas)) return { status: 'fee_cap_wait' };
      const request = { ...payload, account: signer.address, nonce, maxFeePerGas, maxPriorityFeePerGas };
      const balance = await client.getBalance({ address: signer.address, blockTag: 'pending' });
      // Every Ethereum transaction needs at least 21,000 gas. Do not ask an empty wallet to simulate.
      if (balance <= payload.value || balance < payload.value + 21000n * maxFeePerGas) return { status: 'funding_wait' };
      // Estimate before eth_call: an unspecified call gas limit can require a block-sized balance.
      let estimate;
      try { estimate = await client.estimateGas(request); }
      catch (error) {
        const balanceGas = maxFeePerGas > 0n ? (balance - payload.value) / maxFeePerGas : undefined;
        if (insufficientFunds(error, balanceGas !== undefined && balanceGas < BigInt(policy.maxGas) ? balanceGas : undefined)) return { status: 'funding_wait' };
        throw error;
      }
      const gas = (estimate * 120n + 99n) / 100n;
      // Reserve the complete transaction cost before signing.
      const reserve = gas * maxFeePerGas + payload.value;
      if (gas > BigInt(policy.maxGas) || reserve > BigInt(policy.maxTransactionWei)) return { status: 'transaction_cap_wait' };
      const day = (block.timestamp / 86400n).toString();
      const reserved = Object.values(store.load().actions)
        .filter(a => a.day === day || a.receipt?.day === day || !terminal(a.status))
        .reduce((n, a) => n + BigInt(a.reserve), 0n);
      if (reserved + reserve > BigInt(policy.dailyReserveWei)) return { status: 'daily_cap_wait' };
      if (await client.getBalance({ address: signer.address, blockTag: 'pending' }) < reserve) return { status: 'funding_wait' };
      // Simulate the actual bounded request, then persist/sign it. Balance races remain retryable.
      try { await client.call({ ...request, gas }); }
      catch (error) { if (insufficientFunds(error)) return { status: 'funding_wait' }; throw error; }
      const tx = { ...payload, chainId: scope.chainId, type: 'eip1559', nonce, gas, maxFeePerGas, maxPriorityFeePerGas };
      entry = { digest, action, status: 'prepared', day, reserve: reserve.toString(), tx: serialize(tx), attempts: 0 };
      saveAction(id, entry);
    }
    if (!entry.raw) {
      const raw = await signer.signTransaction(hydrate(entry.tx)), parsed = parseTransaction(raw);
      if ((await recoverTransactionAddress({ serializedTransaction: raw })).toLowerCase() !== scope.signer.toLowerCase() ||
          parsed.chainId !== scope.chainId || parsed.nonce !== entry.tx.nonce || parsed.type !== 'eip1559' ||
          (parsed.to?.toLowerCase() ?? null) !== (entry.tx.to ?? null) || (parsed.data ?? '0x') !== entry.tx.data ||
          ['gas', 'value', 'maxFeePerGas', 'maxPriorityFeePerGas'].some(k => BigInt(parsed[k] ?? 0) !== BigInt(entry.tx[k]))) {
        throw new Error('Signer returned a different transaction');
      }
      entry = { ...entry, raw, hash: keccak256(raw), status: 'signed' };
      saveAction(id, entry); // Durable signed bytes before the first network submission.
    }
    let receipt;
    try { receipt = await client.getTransactionReceipt({ hash: entry.hash }); }
    catch (error) { if (error.name !== 'TransactionReceiptNotFoundError') throw error; }
    if (receipt) {
      const finalized = await client.getBlock({ blockTag: 'finalized' });
      const canonical = await client.getBlock({ blockNumber: receipt.blockNumber });
      if (canonical.hash !== receipt.blockHash || receipt.transactionHash !== entry.hash) throw new Error('Receipt is not canonical');
      entry.status = receipt.blockNumber <= finalized.number ? (receipt.status === 'success' ? 'confirmed' : 'reverted')
        : receipt.status === 'success' ? 'mined' : 'mined_reverted';
      entry.receipt = { blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash,
        transactionHash: receipt.transactionHash, status: receipt.status, contractAddress: receipt.contractAddress,
        gasUsed: receipt.gasUsed.toString(), day: (canonical.timestamp / 86400n).toString() };
      saveAction(id, entry); return entry;
    }
    if (await client.getTransactionCount({ address: signer.address, blockTag: 'latest' }) > entry.tx.nonce) {
      throw new Error('Nonce consumed without the journaled receipt');
    }
    // Never allocate a new nonce after a timeout, a dropped transaction or a shallow reorg.
    entry.status = 'broadcast_unknown'; entry.attempts++; saveAction(id, entry);
    try {
      const hash = await client.sendRawTransaction({ serializedTransaction: entry.raw });
      if (hash !== entry.hash) throw new Error('Broadcast hash mismatch');
      entry.status = 'submitted';
    } catch { entry.status = 'broadcast_unknown'; }
    saveAction(id, entry); return entry;
  }
  async function reconcile() {
    if (store.load().halted) throw new Error('Execution store is halted; reconcile before submitting');
    const pending = Object.entries(store.load().actions).filter(([, a]) => !terminal(a.status))
      .sort(([, a], [, b]) => a.tx.nonce - b.tx.nonce);
    const nonces = Object.values(store.load().actions).map(a => a.tx.nonce);
    if (nonces.some(n => !Number.isSafeInteger(n) || n < 0) || new Set(nonces).size !== nonces.length) {
      throw new Error('Invalid or duplicate journal nonce');
    }
    let result = null;
    for (const [id, entry] of pending) {
      result = await run(id, entry.action, true);
      // A gap or revert stops subsequent submissions; successful mined entries remain monitored.
      if (result.status === 'reverted' || (!terminalEntry(result) && !transactionIncluded(result))) return result;
    }
    return result;
  }
  return {
    async advance(id, action) {
      if (busy) throw new Error('Executor is already active');
      busy = true;
      try { return await run(id, action); } finally { busy = false; }
    },
    async resume() {
      if (busy) throw new Error('Executor is already active');
      busy = true;
      try { return await reconcile(); } finally { busy = false; }
    },
  };
}
