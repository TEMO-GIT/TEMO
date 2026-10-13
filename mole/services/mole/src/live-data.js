import { isAddress } from 'viem';
import { hookAbi, tradeEvent } from './contract-abi.js';
import { contractRevision, decodeRecord, finalizedTarget } from './contract-model.js';

export const liveDataPolicy = Object.freeze({ version: 'temo-live-data-v1',
  source: 'temo_hook_only', window: 'all_history', labels: 'contract_finalized_only',
  finality: 'finalized', contractRevision });

// The caller owns checkpoint persistence and serializes runs. No signing or invented timeout labels.
export async function readLiveDataset({ client, hook, deploymentBlock, previous = null,
  blockBatch = 1000, signal }) {
  if (!isAddress(hook) || BigInt(hook) === 0n || typeof deploymentBlock !== 'bigint' || deploymentBlock < 1n ||
      !Number.isSafeInteger(blockBatch) || blockBatch < 1 || blockBatch > 10000) throw new Error('Invalid live source configuration');
  const chainId = await client.getChainId();
  if (chainId !== 1) throw new Error('Live TEMO training requires Ethereum');
  const head = await client.getBlock({ blockTag: 'finalized' });
  if (!head.hash || head.number === null || head.number < deploymentBlock) throw new Error('Deployment is not finalized');
  const identity = { chainId, hook: hook.toLowerCase(), deploymentBlock: deploymentBlock.toString() };
  const read = (functionName, args, blockNumber = head.number) => client.readContract({
    address: hook, abi: hookAbi, functionName, args, blockNumber });
  let rows = [], from = deploymentBlock;
  if (previous) {
    if (JSON.stringify(previous.policy) !== JSON.stringify(liveDataPolicy) ||
        Object.entries(identity).some(([key, value]) => previous.source?.[key] !== value)) throw new Error('Live checkpoint source mismatch');
    const number = BigInt(previous.block.number);
    if (number > head.number) throw new Error('Finalized provider is behind checkpoint');
    const anchor = await client.getBlock({ blockNumber: number });
    if (anchor.hash !== previous.block.hash) throw new Error('Finalized checkpoint changed');
    rows = previous.rows.map((row, i) => {
      if (row.index !== String(i) || !isAddress(row.origin)) throw new Error('Invalid checkpoint record order');
      decodeRecord(row.record);
      return { ...row };
    });
    if (await read('recordCount', [], number) !== BigInt(rows.length)) throw new Error('Checkpoint record count mismatch');
    from = number + 1n;
  } else {
    const code = await client.getCode({ address: hook, blockNumber: deploymentBlock - 1n });
    if (code && code !== '0x' && await read('recordCount', [], deploymentBlock - 1n) !== 0n) {
      throw new Error('Deployment block skips existing hook history');
    }
  }
  for (; from <= head.number; from += BigInt(blockBatch)) {
    signal?.throwIfAborted();
    const toBlock = from + BigInt(blockBatch) - 1n > head.number ? head.number : from + BigInt(blockBatch) - 1n;
    const logs = await client.getLogs({ address: hook, event: tradeEvent, fromBlock: from, toBlock, strict: true });
    logs.sort((a, b) => a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : a.logIndex - b.logIndex);
    for (const log of logs) {
      if (log.removed || log.address?.toLowerCase() !== identity.hook || !log.blockHash || !log.transactionHash ||
          log.blockNumber < from || log.blockNumber > toBlock || !isAddress(log.args.origin) ||
          log.args.index !== BigInt(rows.length)) throw new Error('Invalid or missing Trade event');
      decodeRecord(log.args.record);
      rows.push({ index: log.args.index.toString(), origin: log.args.origin.toLowerCase(),
        record: log.args.record.toString(), blockNumber: log.blockNumber.toString(), blockHash: log.blockHash,
        transactionHash: log.transactionHash, logIndex: log.logIndex });
    }
  }
  if (await read('recordCount', []) !== BigInt(rows.length)) throw new Error('Incomplete live trade history');
  const positions = new Map();
  const examples = [], pendingOrigins = new Set();
  for (const row of rows) {
    signal?.throwIfAborted();
    const decoded = decodeRecord(row.record);
    if (!decoded.labelFinal && !positions.has(decoded.positionId)) {
      positions.set(decoded.positionId, await read('positions', [decoded.positionId]));
    }
    const target = finalizedTarget(row.record, positions.get(decoded.positionId) ?? 0n);
    if (target === null) pendingOrigins.add(row.origin);
    else examples.push({ index: row.index, record: row.record, inputs: decoded.inputs, target,
      positionId: decoded.positionId, origin: row.origin });
  }
  const check = await client.getBlock({ blockNumber: head.number });
  if (check.hash !== head.hash) throw new Error('Finalized snapshot changed during read');
  return { schemaVersion: 1, policy: liveDataPolicy, source: identity,
    block: { number: head.number.toString(), hash: head.hash, timestamp: head.timestamp.toString() },
    rows, examples, pendingOrigins: [...pendingOrigins],
    // Pending origins are candidates to inspect for settleMany, not authorization to settle them.
    transactionsEnabled: false };
}
