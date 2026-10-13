import { isAddress } from 'viem';
import { buriedEvent, burrowAbi } from './contract-abi.js';
import { contractRevision } from './contract-model.js';

const policy = { version: 'temo-capsule-events-v1', contractRevision, finality: 'finalized' };
export const capsuleKey = (season, owner) => `${season}:${owner.toLowerCase()}`;

// Retain opaque ciphertext even when an individual capsule cannot be decrypted.
export async function readCapsuleEvents({ client, burrow, deploymentBlock, previous = null, blockBatch = 1000, signal }) {
  if (!isAddress(burrow) || BigInt(burrow) === 0n || typeof deploymentBlock !== 'bigint' || deploymentBlock < 1n ||
      !Number.isInteger(blockBatch) || blockBatch < 1 || blockBatch > 10000) throw new Error('Invalid capsule source');
  const chainId = await client.getChainId();
  if (chainId !== 1) throw new Error('Capsule source must be Ethereum');
  const head = await client.getBlock({ blockTag: 'finalized' });
  if (!head.hash || head.number === null || head.number < deploymentBlock) throw new Error('Capsule deployment not finalized');
  const source = { chainId, burrow: burrow.toLowerCase(), deploymentBlock: deploymentBlock.toString() };
  let rows = [], from = deploymentBlock;
  if (previous) {
    if (JSON.stringify(previous.source) !== JSON.stringify(source) || JSON.stringify(previous.policy) !== JSON.stringify(policy)) throw new Error('Capsule checkpoint source mismatch');
    const number = BigInt(previous.block.number);
    if (number > head.number || (await client.getBlock({ blockNumber: number })).hash !== previous.block.hash) throw new Error('Capsule finalized checkpoint changed');
    rows = structuredClone(previous.rows); from = number + 1n;
  }
  const read = (functionName, args) => client.readContract({ address: burrow, abi: burrowAbi, functionName, args, blockNumber: head.number });
  const currentSeason = Number(await read('cycleAt', [head.timestamp]));
  const seen = new Set();
  for (const row of rows) {
    if (!Number.isInteger(row.season) || row.season < 1 || row.season > currentSeason || !isAddress(row.owner) ||
        seen.has(capsuleKey(row.season,row.owner))) throw new Error('Invalid capsule checkpoint');
    seen.add(capsuleKey(row.season,row.owner));
  }
  for (; from <= head.number; from += BigInt(blockBatch)) {
    signal?.throwIfAborted();
    const toBlock = from + BigInt(blockBatch) - 1n > head.number ? head.number : from + BigInt(blockBatch) - 1n;
    const logs = await client.getLogs({ address: burrow, event: buriedEvent, fromBlock: from, toBlock, strict: true });
    logs.sort((a,b) => a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : a.logIndex-b.logIndex);
    for (const log of logs) {
      const { season, owner, commit, ciphertext } = log.args;
      if (log.removed || log.address?.toLowerCase() !== source.burrow || !log.blockHash || !log.transactionHash ||
          log.blockNumber < from || log.blockNumber > toBlock || !Number.isInteger(season) || season < 1 || season > currentSeason ||
          !isAddress(owner) || !/^0x[0-9a-f]{64}$/i.test(commit) || !/^0x(?:[0-9a-f]{2})*$/i.test(ciphertext) ||
          seen.has(capsuleKey(season,owner))) throw new Error('Invalid or duplicate Buried event');
      seen.add(capsuleKey(season,owner));
      rows.push({ season, owner: owner.toLowerCase(), commit: commit.toLowerCase(), ciphertext,
        blockNumber: log.blockNumber.toString(), blockHash: log.blockHash,
        transactionHash: log.transactionHash, logIndex: log.logIndex });
    }
  }
  const counts = new Map();
  for (const row of rows) counts.set(row.season, (counts.get(row.season) ?? 0) + 1);
  for (let season = 1; season <= currentSeason; season++) {
    signal?.throwIfAborted();
    if (await read('capsuleCount', [season]) !== BigInt(counts.get(season) ?? 0)) throw new Error('Incomplete capsule event history');
  }
  if ((await client.getBlock({ blockNumber: head.number })).hash !== head.hash) throw new Error('Capsule snapshot changed during read');
  return { policy, source, rows, currentSeason, block: { number: head.number.toString(), hash: head.hash, timestamp: head.timestamp.toString() } };
}
