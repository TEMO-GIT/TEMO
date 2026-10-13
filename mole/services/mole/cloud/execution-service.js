import { createHash, randomUUID } from 'node:crypto';
import { loadWallet } from '../src/wallet.js';
import { openExecutionStore } from '../src/execution-store.js';
import { createTransactionExecutor } from '../src/transaction-executor.js';
import { executionTick } from '../src/execution-worker.js';
import { verifyLaunchBindings } from '../src/launch-bindings.js';
import { verifyDeployment } from '../src/publication.js';
import { createPublicProofHandler } from '../src/public-proof.js';
import { executionStatus } from '../src/execution-status.js';
import { validateExecutionConfig } from './execution-config.js';

// Shared lifecycle; production and development differ only in their pinned identity/profile.
export async function startExecutionService({ config: input, profile, dstack, client, signal,
  port = 8788, hostname = '0.0.0.0', log = event => process.stdout.write(`${JSON.stringify(event)}\n`),
  loadSigner = loadWallet, openStore = openExecutionStore, createExecutor = createTransactionExecutor,
  verifyBindings = verifyLaunchBindings, verifyModel = verifyDeployment, runTick = executionTick }) {
  const config = validateExecutionConfig(structuredClone(input));
  const bootId = randomUUID();
  const releaseConfigSha256 = createHash('sha256').update(`${JSON.stringify(config, null, 2)}\n`).digest('hex');
  const info = structuredClone(await dstack.info());
  if (info.app_id !== profile.appId || !/^[a-f0-9]{64}$/i.test(info.compose_hash ?? '')) throw new Error('Execution app mismatch');
  const signer = await loadSigner(dstack, profile.keyPath, { transactions: config.transactionsEnabled });
  if (signer.address.toLowerCase() !== profile.walletAddress.toLowerCase()) throw new Error('Reserved execution wallet mismatch');
  const scope = { chainId: config.chainId, signer: signer.address, hook: config.hook, model: config.model,
    codeHashes: config.codeHashes, verificationMode: config.verificationMode, contractRevision: config.contractRevision,
    burrow: config.burrow, token: config.token, graphFactory: config.graphFactory };
  const store = await openStore(config.storePath, scope);
  let server, pending, stopping = false, ready = false, status = 'starting';
  let lastTickAt = null, lastSuccessfulTickAt = null;
  try {
    const executor = config.transactionsEnabled ? createExecutor({ client, signer, store, policy: config.gasPolicy }) : null;
    const publicProof = createPublicProofHandler({ client: dstack, walletAddress: signer.address,
      isReady: () => !stopping && !signal?.aborted });
    const snapshot = () => ({ ...executionStatus(store.load(), { status, walletAddress: signer.address,
      mode: profile.mode, transactionsEnabled: config.transactionsEnabled && ready,
      lastTickAt, lastSuccessfulTickAt, stopping: stopping || Boolean(signal?.aborted) }),
      appId: info.app_id, composeHash: info.compose_hash, kmsGovernance: profile.kmsGovernance,
      observationOnly: !config.transactionsEnabled, releaseConfigSha256, bootId });
    server = Bun.serve({ hostname, port, development: false, async fetch(request) {
      const proof = await publicProof(request); if (proof) return proof;
      const path = new URL(request.url).pathname;
      if (!['/health/live', '/health/ready', '/v1/status'].includes(path)) return new Response(null, { status: 404 });
      if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
      const healthy = path === '/health/live' ? !stopping && !signal?.aborted : ready && !store.load().halted && !stopping && !signal?.aborted;
      return new Response(request.method === 'HEAD' ? null : JSON.stringify(snapshot()), {
        status: path.startsWith('/health/') && !healthy ? 503 : 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
      });
    }, error: () => Response.json({ error: 'Internal error' }, { status: 500 }) });
    return { url: server.url.toString(), snapshot,
      tick() {
        if (stopping || signal?.aborted) return Promise.reject(new Error('Execution service is stopping'));
        if (pending) return Promise.reject(new Error('Execution tick already active'));
        pending = (async () => {
          lastTickAt = new Date().toISOString(); ready = false;
          try {
            const current = await dstack.info();
            if (current.app_id !== info.app_id || current.compose_hash !== info.compose_hash) throw new Error('Execution identity changed');
            await verifyBindings({ client, scope, codeHashes: config.codeHashes });
            await verifyModel({ client, scope, codeHashes: config.codeHashes });
            if (signal?.aborted || stopping) throw new Error('Execution service is stopping');
            const result = config.transactionsEnabled
              ? await runTick({ client, executor, store, codeHashes: config.codeHashes,
                deploymentBlock: BigInt(config.deploymentBlock), signal })
              : { status: 'observing' };
            status = result.status; ready = true; lastSuccessfulTickAt = new Date().toISOString();
            log({ event: 'execution_tick', status }); return result;
          } catch (error) {
            status = 'error'; log({ event: 'execution_tick_failed', detailsSuppressed: true }); throw error;
          }
        })().finally(() => { pending = undefined; });
        return pending;
      },
      async stop() {
        stopping = true; ready = false;
        try { await pending; } catch {}
        await server.stop(true); await store.close();
      },
    };
  } catch (error) { await server?.stop(true); await store.close(); throw error; }
}
