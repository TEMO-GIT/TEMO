import { brotliCompressSync } from 'node:zlib';
import { sha256 } from '../files.js';
import { save, json } from './storage.js';
import { validateExecutionConfig } from '../../cloud/execution-config.js';
import { executionProfile } from '../../cloud/profiles.js';

export async function buildExecutionRelease(config, directory) {
  validateExecutionConfig(config);
  const profile = executionProfile('production');
  const options = { entrypoints: [new URL('../../cloud/production-execution-main.js', import.meta.url).pathname], target: 'bun', minify: true, sourcemap: 'none' };
  const first = await Bun.build(options), second = await Bun.build(options);
  if (!first.success || !second.success || first.outputs.length !== 1 || second.outputs.length !== 1) throw Error('Execution build failed');
  const bundle = Buffer.from(await first.outputs[0].arrayBuffer());
  if (!bundle.equals(Buffer.from(await second.outputs[0].arrayBuffer()))) throw Error('Execution build is not reproducible');
  const configText = json(config);
  const packed = brotliCompressSync(Buffer.from(JSON.stringify({ bundle: bundle.toString(), config: configText })));
  const loader = `import{brotliDecompressSync}from'node:zlib';const p=JSON.parse(brotliDecompressSync(Buffer.from(Bun.argv.slice(1).join(''),'base64')));await Bun.write('/tmp/execution.json',p.config);await Bun.write('/tmp/mole.mjs',p.bundle);await import('/tmp/mole.mjs');`;
  const image = 'oven/bun@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4';
  const compose = { services: { mole: { image, platform: 'linux/amd64', restart: 'unless-stopped',
    environment: { TEMO_MOLE_MODE: profile.mode, TEMO_EXECUTION_CONFIG: '/tmp/execution.json', TEMO_DATA_ETHEREUM_RPC_URL: '${TEMO_DATA_ETHEREUM_RPC_URL:?Ethereum RPC credential required}' },
    ports: ['8788:8788'], volumes: ['/var/run/dstack.sock:/var/run/dstack.sock', 'mole-state:/data'],
    read_only: true, tmpfs: ['/tmp:size=32m,mode=1777'], cap_drop: ['ALL'], security_opt: ['no-new-privileges:true'],
    entrypoint: ['bun', '--no-env-file', '-e', loader, ...packed.toString('base64').match(/.{1,32000}/g)],
    logging: { driver: 'json-file', options: { 'max-size': '5m', 'max-file': '2' } },
  } }, volumes: { 'mole-state': {} } };
  const composeText = json(compose);
  if (Buffer.byteLength(composeText) > 250000) throw Error('Execution compose exceeds size limit');
  const build = { schemaVersion: 1, configSha256: sha256(configText), bundleSha256: sha256(bundle),
    dockerComposeSha256: sha256(composeText), image, repeatedBuildIdentical: true,
    releaseDigest: sha256(json({ bundleSha256: sha256(bundle), configSha256: sha256(configText), image })),
    appId: profile.appId, walletAddress: profile.walletAddress, transactionsEnabled: config.transactionsEnabled };
  await save(new URL('execution.json', directory), configText);
  await save(new URL('bundle.mjs', directory), bundle);
  await save(new URL('docker-compose.json', directory), composeText);
  await save(new URL('build.json', directory), build);
  return build;
}
