import { Database } from 'bun:sqlite';
import { mkdir, stat, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function openExecutionStore(path, scope, { create = true } = {}) {
  // Maintenance must never turn a missing journal into an apparently healthy empty one.
  if (!create && !(await stat(path)).isFile()) throw new Error('Existing execution store required');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // A separate SQLite transaction holds an OS lock for the worker lifetime. A process kill
  // releases it automatically, while the journal itself still commits each signed payload.
  // Do not bypass a legacy worker's directory lock during migration.
  if (await stat(`${path}.lock`).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;})) {
    throw new Error('Legacy execution lock exists; verify the old worker is stopped before migration');
  }
  let db, lease;
  try {
    lease = new Database(`${path}.lease`, { create: true, strict: true });
    await chmod(`${path}.lease`, 0o600);
    try { lease.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE'); }
    catch { throw new Error('Execution store already locked'); }
    db = new Database(path, { create, strict: true });
    await chmod(path, 0o600);
    db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL)');
    const load = () => JSON.parse(db.query('SELECT json FROM state WHERE id=1').get().json);
    const save = value => db.query('INSERT INTO state(id,json) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json')
      .run(JSON.stringify(value));
    if (!db.query('SELECT id FROM state WHERE id=1').get()) {
      if (!create) throw new Error('Existing execution state required');
      save({ version: 1, scope, actions: {}, publications: {} });
    }
    const existing = load();
    if (existing.version !== 1 || JSON.stringify(existing.scope) !== JSON.stringify(scope)) throw new Error('Execution store scope mismatch');
    let closed = false;
    return { load, save, async close() { if (!closed) { closed = true; db.close(); lease.close(); } } };
  } catch (error) { db?.close(); lease?.close(); throw error; }
}
