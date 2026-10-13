import { isAddress, keccak256 } from 'viem';
import { hookAbi, modelAbi, burrowAbi } from './contract-abi.js';

export async function verifyLaunchBindings({ client, scope, codeHashes }) {
  if (await client.getChainId() !== scope.chainId) throw new Error('Launch chain mismatch');
  for (const key of ['model','hook','burrow','token','graphFactory','signer']) {
    if (!isAddress(scope[key]) || BigInt(scope[key]) === 0n) throw new Error('Complete launch graph required');
  }
  const block = await client.getBlock({ blockTag: 'finalized' });
  for (const name of ['burrow','token']) {
    const code = await client.getCode({ address: scope[name], blockNumber: block.number });
    if (!/^0x[0-9a-f]{64}$/i.test(codeHashes?.[name] ?? '') || !code || code === '0x' ||
        keccak256(code) !== codeHashes[name].toLowerCase()) throw new Error('Launch graph bytecode mismatch');
  }
  const read = (key,abi,functionName) => client.readContract({address:scope[key],abi,functionName,blockNumber:block.number});
  const bindings = [
    ['hook',hookAbi,'model','model'], ['hook',hookAbi,'burrow','burrow'], ['hook',hookAbi,'token','token'],
    ['model',modelAbi,'hook','hook'], ['model',modelAbi,'deployer','graphFactory'],
    ['burrow',burrowAbi,'hook','hook'], ['burrow',burrowAbi,'mole','signer'],
    ['burrow',burrowAbi,'token','token'], ['burrow',burrowAbi,'deployer','graphFactory'],
  ];
  for (const [key,abi,getter,expected] of bindings) {
    if ((await read(key,abi,getter)).toLowerCase() !== scope[expected].toLowerCase()) throw new Error('Launch graph binding mismatch');
  }
  const [hookTime,burrowTime] = await Promise.all([read('hook',hookAbi,'launchedAt'),read('burrow',burrowAbi,'launchedAt')]);
  if (BigInt(hookTime) === 0n || BigInt(hookTime) !== BigInt(burrowTime)) throw new Error('Launch graph timestamp mismatch');
  return { blockNumber:block.number.toString(),launchedAt:hookTime.toString() };
}
