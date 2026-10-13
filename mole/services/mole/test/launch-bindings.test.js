// DEV-ONLY: graph faults must stop the worker before it signs a transaction.
import { test, expect } from 'bun:test';
import { keccak256 } from 'viem';
import { verifyLaunchBindings } from '../src/launch-bindings.js';
const scope = Object.fromEntries(['model','hook','burrow','token','graphFactory','signer'].map((k,i)=>[k,`0x${String(i+1).repeat(40)}`]));
scope.chainId=1;
const codeHashes={burrow:keccak256('0x6000'),token:keccak256('0x6000')};
function client(change={}) {
  return { getChainId:async()=>1, getBlock:async()=>({number:100n}),getCode:async()=> '0x6000',
    readContract:async({functionName,blockNumber})=>{
      expect(blockNumber).toBe(100n);
      if (functionName==='launchedAt') return 123n;
      return scope[functionName==='deployer'?'graphFactory':functionName==='mole'?'signer':functionName];
    },...change };
}
test('complete graph verifies at one finalized block',async()=>{
  expect(await verifyLaunchBindings({client:client(),scope,codeHashes})).toEqual({blockNumber:'100',launchedAt:'123'});
});
test('wrong chain, code, factory, wallet, timestamp and missing graph are rejected',async()=>{
  for(const change of [
    {getChainId:async()=>2}, {getCode:async()=>'0x6001'},
    ...['deployer','mole','launchedAt'].map(name=>({readContract:async args=>args.functionName===name?
      (name==='launchedAt'?0n:scope.token):client().readContract(args)})),
  ]) await expect(verifyLaunchBindings({client:client(change),scope,codeHashes})).rejects.toThrow();
  await expect(verifyLaunchBindings({client:client(),scope:{...scope,burrow:undefined},codeHashes})).rejects.toThrow();
});
