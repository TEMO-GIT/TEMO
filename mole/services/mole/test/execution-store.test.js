// DEV-ONLY: real child-process termination tests for durable journal ownership.
import { test, expect } from 'bun:test';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { openExecutionStore } from '../src/execution-store.js';

test('exclusive journal lease releases after SIGKILL and preserves the last committed state',async()=>{
  const root=await mkdtemp(`${tmpdir()}/temo-store-kill-`), path=`${root}/state.db`;
  const module=new URL('../src/execution-store.js',import.meta.url).pathname;
  const child=Bun.spawn(['bun','--no-env-file','-e',`
    const {openExecutionStore}=await import(${JSON.stringify(module)});
    const store=await openExecutionStore(${JSON.stringify(path)},{chainId:1});
    const s=store.load();s.marker='durable-before-kill';store.save(s);
    console.log('ready');setInterval(()=>{},10000);
  `],{stdout:'pipe',stderr:'pipe'});
  let store;
  try {
    const reader=child.stdout.getReader();
    const ready=await reader.read();expect(new TextDecoder().decode(ready.value).trim()).toBe('ready');reader.releaseLock();
    await expect(openExecutionStore(path,{chainId:1})).rejects.toThrow('already locked');
    child.kill('SIGKILL');await child.exited;
    store=await openExecutionStore(path,{chainId:1});expect(store.load().marker).toBe('durable-before-kill');
    await expect(openExecutionStore(path,{chainId:1})).rejects.toThrow('already locked');
    await store.close();store=null;
    await expect(openExecutionStore(path,{chainId:2})).rejects.toThrow('scope mismatch');
    store=await openExecutionStore(path,{chainId:1});expect(store.load().marker).toBe('durable-before-kill');
  }finally{child.kill();await child.exited;await store?.close();await rm(root,{recursive:true,force:true});}
},10000);

test('legacy directory lock is not silently bypassed',async()=>{
  const root=await mkdtemp(`${tmpdir()}/temo-store-legacy-`), path=`${root}/state.db`;
  try {await mkdir(`${path}.lock`);await expect(openExecutionStore(path,{})).rejects.toThrow('Legacy');}
  finally{await rm(root,{recursive:true,force:true});}
});
