import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import ui from './ui.js';
import { buildExecutionRelease } from '../services/mole/ops/launch/build.js';
const root = new URL('../', import.meta.url);
try {
  if (Bun.argv[2] === 'release') {
    if (!Bun.argv[3]) throw new Error('Usage: bun run release /absolute/path/to/execution.json');
    const config = await Bun.file(resolve(Bun.argv[3])).json();
    const output = new URL('dist/release/', root);
    await mkdir(output, { recursive: true });
    const result = await buildExecutionRelease(config, output);
    ui.done({ Digest: result.releaseDigest, Directory: output.pathname }, { title: 'Release built' });
  } else {
    if (Bun.argv.length > 2) throw new Error('Usage: bun run build');
    const options = { entrypoints: [new URL('services/mole/cloud/production-execution-main.js', root).pathname], target: 'bun', minify: true, sourcemap: 'none' };
    const a = await Bun.build(options), b = await Bun.build(options);
    if (!a.success || !b.success || a.outputs.length !== 1 || b.outputs.length !== 1) throw new Error('Build failed');
    const bytes = Buffer.from(await a.outputs[0].arrayBuffer());
    if (!bytes.equals(Buffer.from(await b.outputs[0].arrayBuffer()))) throw new Error('Repeated builds differ');
    await Bun.write(new URL('dist/mole.mjs', root), bytes);
    ui.done({ Bytes: bytes.length, Reproducible: true }, { title: 'Production runtime built' });
  }
} catch (error) { ui.err('build', error.message); process.exitCode = 1; }
