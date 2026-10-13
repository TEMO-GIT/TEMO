import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, link, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// Publish only a complete file, never overwrite an existing destination, keep it private.
export async function writePrivateFile(path, bytes) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  let file;
  try {
    file = await open(temporary, 'wx', 0o600);
    await file.writeFile(bytes); await file.sync(); await file.close(); file = null;
    await link(temporary, path);
    const parent = await open(directory, 'r');
    try { await parent.sync(); } finally { await parent.close(); }
  } finally {
    await file?.close();
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}
