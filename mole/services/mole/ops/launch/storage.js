import { mkdir, rename, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { writePrivateFile } from '../files.js';
export const json = x => `${JSON.stringify(x, (_, v) => typeof v === 'bigint' ? String(v) : v, 2)}\n`;
export async function save(path, value) {
  path = path instanceof URL ? path.pathname : path;
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writePrivateFile(temporary, typeof value === 'string' || value instanceof Uint8Array ? value : json(value));
  await rename(temporary, path);
  const directory = await open(dirname(path), 'r'); try { await directory.sync(); } finally { await directory.close(); }
}
export async function load(path) { const f = Bun.file(path); return await f.exists() ? f.json() : null; }
