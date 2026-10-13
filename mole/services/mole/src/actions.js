import { encodeFunctionData, isAddress, keccak256, toBytes } from 'viem';
import { hookAbi, modelAbi, burrowAbi } from './contract-abi.js';
import { decodeWeights } from './contract-model.js';

export const actionId = value => keccak256(toBytes(JSON.stringify(value)));
export const isSeasonAction = action => ['resolve','reveal','publish','rollover'].includes(action?.kind);
export function buildAction(action, scope) {
  let to, data, value = 0n;
  if (action.kind === 'weights') {
    decodeWeights(action.bytes);
    if (action.bytes.slice(2, 4).toLowerCase() === 'ef') throw new Error('EIP-3541 rejects this weight-store prefix');
    data = `0x61016280600c6000396000f3${action.bytes.slice(2)}`;
  } else if (action.kind === 'settle') {
    if (!Array.isArray(action.origins) || !action.origins.length || action.origins.length > 64 ||
        action.origins.some(a => !isAddress(a)) || new Set(action.origins.map(a => a.toLowerCase())).size !== action.origins.length) throw new Error('Invalid settlement batch');
    to = scope.hook; data = encodeFunctionData({ abi: hookAbi, functionName: 'settleMany', args: [action.origins] });
  } else if (action.kind === 'commit') {
    if (!isAddress(action.weights) || BigInt(action.weights) === 0n) throw new Error('Invalid candidate address');
    to = scope.model; data = encodeFunctionData({ abi: modelAbi, functionName: 'commit', args: [action.weights] });
  } else if (action.kind === 'judge') {
    if (action.signature !== '0x' && !/^0x[0-9a-f]{256}$/i.test(action.signature)) throw new Error('Invalid judgment signature');
    to = scope.model; data = encodeFunctionData({ abi: modelAbi, functionName: 'judge', args: [action.signature] });
  } else if (isSeasonAction(action)) {
    if (!Number.isInteger(action.season) || action.season < 1 || action.season > 0xffffffff) throw new Error('Invalid season');
    const answersValid = answers => Array.isArray(answers) && answers.length === 9 &&
      answers.every(v => Number.isInteger(v) && v >= 0 && v <= 255);
    let args = [action.season];
    if (action.kind === 'reveal') {
      if (!isAddress(action.owner) || !answersValid(action.answers) || !/^0x[0-9a-f]{64}$/i.test(action.salt ?? '')) throw new Error('Invalid capsule opening');
      args.push(action.owner, action.answers, action.salt);
    } else if (action.kind === 'publish') {
      if (!Array.isArray(action.owners) || !action.owners.length || action.owners.length > 32 ||
          action.owners.some(a => !isAddress(a)) || new Set(action.owners.map(a => a.toLowerCase())).size !== action.owners.length ||
          !Array.isArray(action.answers) || action.answers.length !== action.owners.length || !action.answers.every(answersValid)) throw new Error('Invalid publication batch');
      args.push(action.owners, action.answers);
    }
    to = scope.burrow; data = encodeFunctionData({ abi: burrowAbi, functionName: action.kind, args });
  } else throw new Error('Unsupported mole action');
  if (to !== undefined && (!isAddress(to) || BigInt(to) === 0n)) throw new Error('Invalid action destination');
  return { ...(to ? { to: to.toLowerCase() } : {}), data: data.toLowerCase(), value };
}

export async function dueSettlements({ client, hook, origins, limit = 64 }) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 64) throw new Error('Invalid settlement limit');
  const head = await client.getBlock({ blockTag: 'latest' }), due = [];
  for (const origin of new Set(origins.map(a => a.toLowerCase()))) {
    if (!isAddress(origin)) throw new Error('Invalid settlement origin');
    const p = await client.readContract({ address: hook, abi: hookAbi, functionName: 'profiles', args: [origin], blockNumber: head.number });
    if (BigInt(p[5]) !== 0n && head.timestamp >= BigInt(p[6]) + 72000n) {
      due.push({ origin, positionId: Number(p[4]), lastBuyTs: p[6].toString() });
      if (due.length === limit) break;
    }
  }
  if (!due.length) return null;
  return { kind: 'settle', origins: due.map(p => p.origin), positions: due,
    id: actionId({ hook: hook.toLowerCase(), due }) };
}
