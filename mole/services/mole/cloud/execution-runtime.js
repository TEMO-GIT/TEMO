import { stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { DstackClient } from '@phala/dstack-sdk';
import { createPublicClient, http } from 'viem';
import { executionProfile } from './profiles.js';
import { startExecutionService } from './execution-service.js';

export async function runExecutionRuntime(target) {
  const profile = executionProfile(target), abort = new AbortController();
  const stop = () => abort.abort();
  for (const event of ['SIGINT', 'SIGTERM']) process.once(event, stop);
  let service;
  try {
    if (process.env.TEMO_MOLE_MODE !== profile.mode) throw new Error('Explicit execution mode required');
    if (!process.env.TEMO_DATA_ETHEREUM_RPC_URL) throw new Error('Ethereum RPC required');
    if (!(await stat('/var/run/dstack.sock')).isSocket()) throw new Error('Real guest socket required');
    const config = await Bun.file(process.env.TEMO_EXECUTION_CONFIG ?? '').json();
    const dstack = new DstackClient('/var/run/dstack.sock');
    const client = createPublicClient({ transport: http(process.env.TEMO_DATA_ETHEREUM_RPC_URL,
      { timeout: 20000, retryCount: 0, fetchOptions: { signal: abort.signal } }) });
    service = await startExecutionService({ config, profile, dstack, client, signal: abort.signal });
    while (!abort.signal.aborted) {
      try { await service.tick(); } catch {}
      await delay(60000, undefined, { signal: abort.signal }).catch(() => {});
    }
  } catch {
    process.stdout.write(`${JSON.stringify({ event: 'execution_startup_failed', detailsSuppressed: true })}\n`);
    process.exitCode = 1;
  } finally {
    await service?.stop();
    for (const event of ['SIGINT', 'SIGTERM']) process.removeListener(event, stop);
  }
}
